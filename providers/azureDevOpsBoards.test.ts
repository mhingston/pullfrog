import { AzureDevOpsBoardsProvider } from "./azureDevOpsBoards.ts";
import type { AzureDevOpsRepositoryContext } from "../utils/azureDevOps.ts";

const ctx: AzureDevOpsRepositoryContext = {
  collectionUri: "https://dev.azure.com/acme/",
  project: "Platform",
  repositoryId: "repo-guid",
  repositoryUri: "https://dev.azure.com/acme/Platform/_git/widget",
  defaultBranch: "main",
  authorization: "Bearer job-token",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawWorkItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    rev: 7,
    fields: {
      "System.WorkItemType": "User Story",
      "System.Title": "Fix stale cache race",
      "System.Description": "Observed under load",
      "System.State": "Active",
      "System.Tags": "backend; reliability",
      "System.CreatedBy": {
        id: "actor-1",
        displayName: "Mark",
        uniqueName: "mark@example.invalid",
      },
      "System.AssignedTo": {
        id: "actor-2",
        displayName: "Engineer",
      },
      "System.CreatedDate": "2026-10-05T08:00:00Z",
      "System.ChangedDate": "2026-10-05T08:10:00Z",
    },
    relations: [
      {
        rel: "System.LinkTypes.Related",
        url: "https://dev.azure.com/acme/Platform/_apis/wit/workItems/41",
      },
      {
        rel: "ArtifactLink",
        url: "vstfs:///Git/PullRequestId/project-guid%2Frepo-guid%2F17",
        attributes: { name: "Pull Request" },
      },
      {
        rel: "ArtifactLink",
        url: "vstfs:///Git/Commit/project-guid%2Frepo-guid%2F0123456789abcdef",
        attributes: { name: "Fixed in Commit" },
      },
    ],
    ...overrides,
  };
}

describe("AzureDevOpsBoardsProvider normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes work-item fields, immutable identities, tags, and useful relations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(rawWorkItem()))
    );
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(provider.getWorkItem(42)).resolves.toMatchObject({
      provider: "azure-devops",
      project: "Platform",
      repository: { id: "repo-guid" },
      id: 42,
      revision: 7,
      type: "User Story",
      title: "Fix stale cache race",
      state: "Active",
      tags: ["backend", "reliability"],
      author: { id: "actor-1", displayName: "Mark" },
      assignedTo: { id: "actor-2" },
      relations: [
        { kind: "work-item", id: "41" },
        { kind: "pull-request", id: "17" },
        { kind: "commit", id: "0123456789abcdef" },
      ],
    });
  });

  it("bounds and normalizes work-item comments", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(
        "/_apis/wit/workitems/42/comments?"
      );
      return jsonResponse({
        comments: [
          {
            id: 5,
            text: "@pullfrog plan this",
            createdBy: { id: "actor-1", displayName: "Mark" },
            createdDate: "2026-10-05T08:00:00Z",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(provider.getComments(42)).resolves.toEqual({
      comments: [
        {
          id: 5,
          body: "@pullfrog plan this",
          author: { id: "actor-1", displayName: "Mark" },
          createdAt: "2026-10-05T08:00:00Z",
        },
      ],
      truncated: false,
    });
  });
});

describe("AzureDevOpsBoardsProvider allowlisted writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a revision test and emits only tags/state patches", async () => {
    const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse(rawWorkItem());
      }
      expect(init?.method).toBe("PATCH");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json-patch+json"
      );
      expect(JSON.parse(String(init?.body))).toEqual([
        { op: "test", path: "/rev", value: 7 },
        {
          op: "add",
          path: "/fields/System.Tags",
          value: "backend; bug",
        },
        {
          op: "add",
          path: "/fields/System.State",
          value: "Resolved",
        },
      ]);
      return jsonResponse(
        rawWorkItem({
          rev: 8,
          fields: {
            ...(rawWorkItem().fields as Record<string, unknown>),
            "System.Tags": "backend; bug",
            "System.State": "Resolved",
          },
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(
      provider.updateWorkItem({
        id: 42,
        expectedRevision: 7,
        mutations: [
          { kind: "tags", add: ["bug"], remove: ["reliability"] },
          { kind: "state", state: "Resolved" },
        ],
      })
    ).resolves.toMatchObject({
      revision: 8,
      tags: ["backend", "bug"],
      state: "Resolved",
    });
    expect(requests).toHaveLength(2);
  });

  it("rejects stale revision before PATCH", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(rawWorkItem({ rev: 8 }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(
      provider.updateWorkItem({
        id: 42,
        expectedRevision: 7,
        mutations: [{ kind: "tags", add: ["bug"] }],
      })
    ).rejects.toThrow("advanced from revision 7 to 8");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary field mutation shapes at runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(rawWorkItem()))
    );
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(
      provider.updateWorkItem({
        id: 42,
        expectedRevision: 7,
        mutations: [
          {
            kind: "field",
            referenceName: "System.Priority",
            value: 1,
          } as any,
        ],
      })
    ).rejects.toThrow("unsupported mutation kind");
  });

  it("validates generated hyperlinks rather than exposing arbitrary relation patches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(rawWorkItem()))
    );
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(
      provider.updateWorkItem({
        id: 42,
        expectedRevision: 7,
        mutations: [
          {
            kind: "hyperlink",
            url: "javascript:alert(1)",
          },
        ],
      })
    ).rejects.toThrow("requires http/https");
  });

  it("posts and edits comments through the comments API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(url).toContain("/workitems/42/comments?");
        expect(url).toContain("format=markdown");
        expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
        return jsonResponse({ id: 5, text: "hello" });
      }
      expect(init?.method).toBe("PATCH");
      expect(url).toContain("/workitems/42/comments/5?");
      expect(url).toContain("format=markdown");
      expect(JSON.parse(String(init?.body))).toEqual({ text: "updated" });
      return jsonResponse({ id: 5, text: "updated" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(provider.addComment(42, "hello")).resolves.toMatchObject({
      id: 5,
      body: "hello",
    });
    await expect(provider.editComment(42, 5, "updated")).resolves.toMatchObject({
      id: 5,
      body: "updated",
    });
  });
});

describe("AzureDevOpsBoardsProvider search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses bounded WIQL retrieval and excludes the current item", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/_apis/wit/wiql?")) {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("[System.TeamProject] = @project");
        expect(body.query).toContain("[System.Id] <> 42");
        expect(body.query).toContain("[System.Title] CONTAINS 'cache'");
        return jsonResponse({
          workItems: [{ id: 41 }, { id: 40 }],
        });
      }
      const id = url.includes("/41?") ? 41 : 40;
      return jsonResponse(
        rawWorkItem({
          id,
          fields: {
            ...(rawWorkItem().fields as Record<string, unknown>),
            "System.Title": "Candidate " + id,
          },
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(
      provider.searchWorkItems({
        terms: ["cache"],
        excludeId: 42,
        max: 20,
      })
    ).resolves.toMatchObject({
      incomplete: false,
      items: [
        { id: 41, title: "Candidate 41" },
        { id: 40, title: "Candidate 40" },
      ],
    });
  });

  it("rejects query operators in terms", async () => {
    const provider = new AzureDevOpsBoardsProvider(ctx);
    await expect(
      provider.searchWorkItems({
        terms: ["cache OR 1=1"],
      })
    ).rejects.toThrow("letters, digits");
  });
});


describe("AzureDevOpsBoardsProvider changed-item polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keyset-paginates beyond 500-era single-page limits with bounded GET concurrency", async () => {
    let activeGets = 0;
    let maxActiveGets = 0;
    const wiqlQueries: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/_apis/wit/wiql?")) {
        const query = String(JSON.parse(String(init?.body)).query);
        wiqlQueries.push(query);
        const cursorMatch = query.match(/\[System\.Id\] > (\d+)/);
        const cursor = cursorMatch ? Number(cursorMatch[1]) : 0;
        if (cursor === 0) {
          return jsonResponse({
            workItems: Array.from({ length: 101 }, (_, index) => ({ id: index + 1 })),
          });
        }
        if (cursor === 100) {
          return jsonResponse({
            workItems: Array.from({ length: 101 }, (_, index) => ({ id: index + 101 })),
          });
        }
        if (cursor === 200) {
          return jsonResponse({
            workItems: Array.from({ length: 5 }, (_, index) => ({ id: index + 201 })),
          });
        }
        throw new Error("unexpected polling cursor " + cursor);
      }

      const match = url.match(/\/workitems\/(\d+)\?/i);
      if (!match) throw new Error("unexpected URL " + url);
      const id = Number(match[1]);
      activeGets++;
      maxActiveGets = Math.max(maxActiveGets, activeGets);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeGets--;
      return jsonResponse(
        rawWorkItem({
          id,
          fields: {
            ...(rawWorkItem().fields as Record<string, unknown>),
            "System.Title": "Changed " + id,
          },
        })
      );
    });

    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsBoardsProvider(ctx);
    const result = await provider.listChangedWorkItems({
      after: new Date("2026-10-05T00:00:00Z"),
      max: 205,
    });

    expect(result.incomplete).toBe(false);
    expect(result.items).toHaveLength(205);
    expect(result.items[0]?.id).toBe(1);
    expect(result.items[204]?.id).toBe(205);
    expect(wiqlQueries).toHaveLength(3);
    expect(wiqlQueries[1]).toContain("[System.Id] > 100");
    expect(wiqlQueries[2]).toContain("[System.Id] > 200");
    expect(maxActiveGets).toBeGreaterThan(1);
    expect(maxActiveGets).toBeLessThanOrEqual(8);
  });

  it("reports when the explicit changed-item scan bound is reached", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/_apis/wit/wiql?")) {
        return jsonResponse({
          workItems: [{ id: 1 }, { id: 2 }, { id: 3 }],
        });
      }
      const match = url.match(/\/workitems\/(\d+)\?/i);
      const id = Number(match?.[1] ?? 0);
      return jsonResponse(rawWorkItem({ id }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AzureDevOpsBoardsProvider(ctx);

    await expect(
      provider.listChangedWorkItems({
        after: new Date("2026-10-05T00:00:00Z"),
        max: 2,
      })
    ).resolves.toMatchObject({
      incomplete: true,
      items: [{ id: 1 }, { id: 2 }],
    });
  });
});
