import {
  azureDevOpsFindingMarker,
  AzureDevOpsClient,
  resolveAzureDevOpsContext,
} from "./azureDevOps.ts";

const sourceCommitId = "0123456789abcdef0123456789abcdef01234567";
const newerCommitId = "fedcba9876543210fedcba9876543210fedcba98";
const baseEnv = {
  SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme",
  SYSTEM_TEAMPROJECT: "Platform",
  BUILD_REPOSITORY_ID: "repo-guid",
  BUILD_REPOSITORY_URI: "https://dev.azure.com/acme/Platform/_git/widget",
  BUILD_REPOSITORY_PROVIDER: "TfsGit",
  SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
  SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature/azdo",
  SYSTEM_PULLREQUEST_SOURCECOMMITID: sourceCommitId,
  SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
  SYSTEM_ACCESSTOKEN: "job-token",
} satisfies NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AzureDevOpsClient review status", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts an iteration-scoped pullfrog/review status", async () => {
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: sourceCommitId } });
      }
      if (url.endsWith("/pullRequests/42/iterations?api-version=7.1")) {
        return jsonResponse({
          count: 1,
          value: [
            {
              id: 3,
              sourceRefCommit: { commitId: sourceCommitId },
            },
          ],
        });
      }
      if (url.endsWith("/pullRequests/42/statuses?api-version=7.1") && method === "POST") {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: 71, state: "failed" });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.publishReviewStatus({
        sourceCommitId,
        state: "failed",
        description: "Pullfrog found one actionable issue.",
      })
    ).resolves.toEqual({
      published: true,
      statusId: 71,
      iterationId: 3,
    });

    expect(postedBody).toMatchObject({
      iterationId: 3,
      state: "failed",
      context: { genre: "pullfrog", name: "review" },
    });
  });

  it("does not post a status for a superseded source", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: newerCommitId } });
      }
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.publishReviewStatus({
        sourceCommitId,
        state: "succeeded",
        description: "clean",
      })
    ).resolves.toEqual({
      published: false,
      supersededBy: newerCommitId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("AzureDevOpsClient inline findings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an inline thread with cumulative iteration tracking context", async () => {
    const threads: Array<{
      id: number;
      status: number;
      comments: Array<{ id: number; content: string }>;
    }> = [];
    let postedBody: Record<string, any> | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: sourceCommitId } });
      }
      if (url.endsWith("/pullRequests/42/iterations?api-version=7.1")) {
        return jsonResponse({
          count: 1,
          value: [
            { id: 3, sourceRefCommit: { commitId: sourceCommitId } },
          ],
        });
      }
      if (url.includes("/pullRequests/42/iterations/3/changes?")) {
        return jsonResponse({
          changeEntries: [
            { changeTrackingId: 5, item: { path: "/src/a.ts" } },
          ],
          nextSkip: 0,
          nextTop: 0,
        });
      }
      if (url.endsWith("/pullRequests/42/threads?api-version=7.1") && method === "GET") {
        return jsonResponse({ value: threads });
      }
      if (url.endsWith("/pullRequests/42/threads?api-version=7.1") && method === "POST") {
        postedBody = JSON.parse(String(init?.body));
        const content = String(postedBody?.comments?.[0]?.content ?? "");
        threads.push({
          id: 99,
          status: 1,
          comments: [{ id: 100, content }],
        });
        return jsonResponse({ id: 99 });
      }
      if (url.endsWith("/threads/99?api-version=7.1") && method === "PATCH") {
        return jsonResponse({ id: 99 });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.upsertInlineReviewThreads(
        [{ path: "src/a.ts", line: 12, body: "**HIGH — race**\n\ndetails" }],
        sourceCommitId
      )
    ).resolves.toEqual({
      published: true,
      iterationId: 3,
      threadIds: [99],
      skipped: [],
    });

    expect(postedBody).toMatchObject({
      status: 1,
      threadContext: {
        filePath: "/src/a.ts",
        rightFileStart: { line: 12, offset: 1 },
        rightFileEnd: { line: 12, offset: 1 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 5,
        iterationContext: {
          firstComparingIteration: 0,
          secondComparingIteration: 3,
        },
      },
    });
    expect(String(postedBody?.comments?.[0]?.content)).toContain(
      azureDevOpsFindingMarker(sourceCommitId, "src/a.ts", 12)
    );
  });

  it("updates the same-location finding and closes findings that disappeared", async () => {
    const currentMarker = azureDevOpsFindingMarker(sourceCommitId, "src/a.ts", 12);
    const obsoleteMarker = azureDevOpsFindingMarker(sourceCommitId, "src/b.ts", 7);
    const threads = [
      {
        id: 10,
        status: 1,
        comments: [{ id: 20, content: "old A\n\n" + currentMarker }],
      },
      {
        id: 11,
        status: 1,
        comments: [{ id: 21, content: "old B\n\n" + obsoleteMarker }],
      },
    ];
    const statuses = new Map<number, number>();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: sourceCommitId } });
      }
      if (url.endsWith("/pullRequests/42/iterations?api-version=7.1")) {
        return jsonResponse({
          count: 1,
          value: [
            { id: 3, sourceRefCommit: { commitId: sourceCommitId } },
          ],
        });
      }
      if (url.includes("/pullRequests/42/iterations/3/changes?")) {
        return jsonResponse({
          changeEntries: [
            { changeTrackingId: 5, item: { path: "/src/a.ts" } },
            { changeTrackingId: 6, item: { path: "/src/b.ts" } },
          ],
          nextSkip: 0,
          nextTop: 0,
        });
      }
      if (url.endsWith("/pullRequests/42/threads?api-version=7.1") && method === "GET") {
        return jsonResponse({ value: threads });
      }
      const commentMatch = url.match(/\/threads\/(\d+)\/comments\/(\d+)\?api-version=7\.1$/);
      if (commentMatch && method === "PATCH") {
        const thread = threads.find((candidate) => candidate.id === Number(commentMatch[1]));
        if (!thread) throw new Error("unknown thread");
        const body = JSON.parse(String(init?.body));
        thread.comments[0]!.content = body.content;
        return jsonResponse({ id: Number(commentMatch[2]) });
      }
      const threadMatch = url.match(/\/threads\/(\d+)\?api-version=7\.1$/);
      if (threadMatch && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        statuses.set(Number(threadMatch[1]), body.status);
        return jsonResponse({ id: Number(threadMatch[1]) });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    const result = await client.upsertInlineReviewThreads(
      [{ path: "src/a.ts", line: 12, body: "new A" }],
      sourceCommitId
    );

    expect(result).toMatchObject({
      published: true,
      threadIds: [10],
    });
    expect(threads[0]!.comments[0]!.content).toContain("new A");
    expect(statuses.get(10)).toBe(1);
    expect(statuses.get(11)).toBe(4);
  });

  it("does not mutate newer-source threads when the head advances mid-publication", async () => {
    const staleMarker = azureDevOpsFindingMarker(sourceCommitId, "src/a.ts", 12);
    const newerMarker = azureDevOpsFindingMarker(newerCommitId, "src/b.ts", 7);
    const threads = [
      {
        id: 10,
        status: 1,
        comments: [{ id: 20, content: "stale finding\n\n" + staleMarker }],
      },
      {
        id: 11,
        status: 1,
        comments: [{ id: 21, content: "newer finding\n\n" + newerMarker }],
      },
    ];
    const statuses = new Map<number, number>();
    let liveChecks = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        liveChecks += 1;
        return jsonResponse({
          lastMergeSourceCommit: {
            commitId: liveChecks === 1 ? sourceCommitId : newerCommitId,
          },
        });
      }
      if (url.endsWith("/pullRequests/42/iterations?api-version=7.1")) {
        return jsonResponse({
          count: 1,
          value: [
            { id: 3, sourceRefCommit: { commitId: sourceCommitId } },
          ],
        });
      }
      if (url.includes("/pullRequests/42/iterations/3/changes?")) {
        return jsonResponse({
          changeEntries: [
            { changeTrackingId: 5, item: { path: "/src/a.ts" } },
          ],
          nextSkip: 0,
          nextTop: 0,
        });
      }
      if (url.endsWith("/pullRequests/42/threads?api-version=7.1") && method === "GET") {
        return jsonResponse({ value: threads });
      }
      if (url.includes("/threads/10/comments/20?api-version=7.1") && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        threads[0]!.comments[0]!.content = body.content;
        return jsonResponse({ id: 20 });
      }
      const threadMatch = url.match(/\/threads\/(\d+)\?api-version=7\.1$/);
      if (threadMatch && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        statuses.set(Number(threadMatch[1]), body.status);
        return jsonResponse({ id: Number(threadMatch[1]) });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.upsertInlineReviewThreads(
        [{ path: "src/a.ts", line: 12, body: "updated stale finding" }],
        sourceCommitId
      )
    ).resolves.toEqual({
      published: false,
      supersededBy: newerCommitId,
    });

    expect(statuses.get(10)).toBe(4);
    expect(statuses.has(11)).toBe(false);
  });

  it("keeps locations in the summary when Azure cannot map the file", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: sourceCommitId } });
      }
      if (url.endsWith("/pullRequests/42/iterations?api-version=7.1")) {
        return jsonResponse({
          count: 1,
          value: [
            { id: 3, sourceRefCommit: { commitId: sourceCommitId } },
          ],
        });
      }
      if (url.includes("/pullRequests/42/iterations/3/changes?")) {
        return jsonResponse({ changeEntries: [], nextSkip: 0, nextTop: 0 });
      }
      if (url.endsWith("/pullRequests/42/threads?api-version=7.1") && method === "GET") {
        return jsonResponse({ value: [] });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.upsertInlineReviewThreads(
        [{ path: "src/missing.ts", line: 4, body: "finding" }],
        sourceCommitId
      )
    ).resolves.toMatchObject({
      published: true,
      threadIds: [],
      skipped: [
        {
          path: "src/missing.ts",
          line: 4,
          reason: expect.stringContaining("not found"),
        },
      ],
    });
  });
});
