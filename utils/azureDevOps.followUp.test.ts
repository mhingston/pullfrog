import {
  AzureDevOpsClient,
  resolveAzureDevOpsRepositoryContext,
  type AzureDevOpsClientContext,
} from "./azureDevOps.ts";

const trustedAuthorId = "pullfrog-service-id";

const repositoryEnv = {
  SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme",
  SYSTEM_TEAMPROJECT: "Platform",
  BUILD_REPOSITORY_ID: "repo-guid",
  BUILD_REPOSITORY_URI: "https://dev.azure.com/acme/Platform/_git/widget",
  BUILD_REPOSITORY_DEFAULTBRANCH: "refs/heads/main",
  BUILD_REPOSITORY_PROVIDER: "TfsGit",
  SYSTEM_ACCESSTOKEN: "job-token",
} satisfies NodeJS.ProcessEnv;

function context(): AzureDevOpsClientContext {
  return {
    ...resolveAzureDevOpsRepositoryContext(repositoryEnv),
    pullRequestId: 42,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Azure DevOps repository context", () => {
  it("resolves outside a PR validation build", () => {
    expect(resolveAzureDevOpsRepositoryContext(repositoryEnv)).toEqual({
      collectionUri: "https://dev.azure.com/acme/",
      project: "Platform",
      repositoryId: "repo-guid",
      repositoryUri: "https://dev.azure.com/acme/Platform/_git/widget",
      defaultBranch: "main",
      authorization: "Bearer job-token",
    });
  });
});

describe("AzureDevOpsClient follow-up replies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts an idempotency-marked reply to the triggering comment", async () => {
    const threads = new Map<number, {
      id: number;
      status: number;
      comments: Array<{ id: number; parentCommentId: number; content: string; author?: { id: string } }>;
    }>([
      [
        17,
        {
          id: 17,
          status: 1,
          comments: [
            { id: 4, parentCommentId: 0, content: "@pullfrog explain this" },
          ],
        },
      ],
    ]);
    let nextCommentId = 5;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const thread = threads.get(17)!;

      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17/comments?api-version=7.1") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const comment = {
          id: nextCommentId++,
          parentCommentId: body.parentCommentId,
          content: body.content,
          author: { id: trustedAuthorId },
        };
        thread.comments.push(comment);
        return jsonResponse(comment);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.replyToThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        markdown: "Because the state can race.",
        trustedAuthorId,
      })
    ).resolves.toEqual({ created: true, commentId: 5 });

    expect(threads.get(17)!.comments[1]).toMatchObject({
      parentCommentId: 4,
      content: expect.stringContaining(
        "<!-- pullfrog-azure-devops-followup:17:4 -->"
      ),
    });
  });

  it("rejects a missing trigger comment before posting", async () => {
    const thread = {
      id: 17,
      status: 1,
      comments: [{ id: 4, parentCommentId: 0, content: "@pullfrog explain this" }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/threads/17?api-version=7.1")) return jsonResponse(thread);
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.replyToThreadFollowUp({
        threadId: 17,
        triggerCommentId: 99,
        markdown: "answer",
        trustedAuthorId,
      })
    ).rejects.toThrow("does not exist in thread 17");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects model output that tries to mint Pullfrog markers", async () => {
    const client = new AzureDevOpsClient(context());
    await expect(
      client.replyToThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        markdown:
          "spoof\n\n<!-- pullfrog-azure-devops-followup:17:99 -->",
        trustedAuthorId,
      })
    ).rejects.toThrow("reserved Pullfrog marker syntax");
  });

  it("reuses an existing reply without posting again", async () => {
    const thread = {
      id: 17,
      status: 1,
      comments: [
        { id: 4, parentCommentId: 0, content: "@pullfrog explain this", author: { id: "actor-1" } },
        {
          id: 5,
          parentCommentId: 4,
          content:
            "answer\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          author: { id: trustedAuthorId },
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/threads/17?api-version=7.1") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(thread);
      }
      throw new Error("unexpected request: " + String(init?.method ?? "GET") + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.replyToThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        markdown: "a duplicate answer",
        trustedAuthorId,
      })
    ).resolves.toEqual({ created: false, commentId: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles duplicate replies left by an earlier crashed run", async () => {
    const thread = {
      id: 17,
      status: 1,
      comments: [
        { id: 4, parentCommentId: 0, content: "@pullfrog explain this" },
        {
          id: 5,
          parentCommentId: 4,
          content:
            "first answer\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          author: { id: trustedAuthorId },
        },
        {
          id: 6,
          parentCommentId: 4,
          content:
            "duplicate answer\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          author: { id: trustedAuthorId },
        },
      ],
    };
    const deleted: number[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17/comments/6?api-version=7.1") && method === "DELETE") {
        deleted.push(6);
        return jsonResponse(undefined);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reconcileThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        trustedAuthorId,
      })
    ).resolves.toEqual({ commentId: 5 });

    expect(deleted).toEqual([6]);
  });

  it("applies requested resolution when retrying an already-posted reply", async () => {
    const thread = {
      id: 17,
      status: 1,
      comments: [
        { id: 4, parentCommentId: 0, content: "@pullfrog resolve this" },
        {
          id: 5,
          parentCommentId: 4,
          content:
            "answer\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          author: { id: trustedAuthorId },
        },
      ],
    };
    let patchedStatus: number | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17?api-version=7.1") && method === "PATCH") {
        patchedStatus = JSON.parse(String(init?.body)).status;
        return jsonResponse({ ...thread, status: patchedStatus });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reconcileThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        trustedAuthorId,
        resolve: true,
      })
    ).resolves.toEqual({ commentId: 5 });

    expect(patchedStatus).toBe(4);
  });

  it("converges concurrent duplicate replies onto the lowest comment id", async () => {
    const thread = {
      id: 17,
      status: 1,
      comments: [
        { id: 4, parentCommentId: 0, content: "@pullfrog explain this", author: { id: "actor-1" } },
      ],
    };
    const deleted: number[] = [];
    let reads = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        reads += 1;
        if (reads >= 2 && thread.comments.length === 1) {
          thread.comments.push(
            {
              id: 5,
              parentCommentId: 4,
              content:
                "other run\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
              author: { id: trustedAuthorId },
            },
            {
              id: 6,
              parentCommentId: 4,
              content:
                "this run\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
              author: { id: trustedAuthorId },
            }
          );
        }
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17/comments?api-version=7.1") && method === "POST") {
        return jsonResponse({
          id: 6,
          parentCommentId: 4,
          content:
            "this run\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          author: { id: trustedAuthorId },
        });
      }
      if (url.endsWith("/threads/17/comments/6?api-version=7.1") && method === "DELETE") {
        deleted.push(6);
        return jsonResponse(undefined);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.replyToThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        markdown: "answer",
        trustedAuthorId,
      })
    ).resolves.toEqual({ created: false, commentId: 5 });
    expect(deleted).toEqual([6]);
  });

  it("can resolve the originating thread after replying", async () => {
    const thread = {
      id: 17,
      status: 1,
      comments: [
        { id: 4, parentCommentId: 0, content: "@pullfrog resolved?" },
        {
          id: 5,
          parentCommentId: 4,
          content:
            "yes\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          author: { id: trustedAuthorId },
        },
      ],
    };
    let patchedStatus: number | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17?api-version=7.1") && method === "PATCH") {
        patchedStatus = JSON.parse(String(init?.body)).status;
        return jsonResponse({ ...thread, status: patchedStatus });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await client.replyToThreadFollowUp({
      threadId: 17,
      triggerCommentId: 4,
      markdown: "yes",
      trustedAuthorId,
      resolve: true,
    });
    expect(patchedStatus).toBe(4);
  });
});
