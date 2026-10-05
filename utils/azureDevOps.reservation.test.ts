import {
  AzureDevOpsClient,
  resolveAzureDevOpsRepositoryContext,
  type AzureDevOpsClientContext,
} from "./azureDevOps.ts";

const env = {
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
    ...resolveAzureDevOpsRepositoryContext(env),
    pullRequestId: 42,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reservationMarker(
  threadId: number,
  triggerCommentId: number,
  claimId: string
): string {
  return (
    "<!-- pullfrog-azure-devops-followup-reservation:" +
    threadId +
    ":" +
    triggerCommentId +
    ":" +
    claimId +
    " -->"
  );
}

describe("AzureDevOpsClient follow-up reservations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails closed when another live reservation exists", async () => {
    const thread = {
      id: 17,
      comments: [
        { id: 4, content: "@pullfrog explain this" },
        {
          id: 5,
          parentCommentId: 4,
          content: reservationMarker(17, 4, "claim-other"),
          publishedDate: "2026-10-05T05:59:00Z",
        },
      ],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        return jsonResponse(thread);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reserveThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        claimId: "claim-mine1",
        now: new Date("2026-10-05T06:00:00Z"),
        settleMs: 0,
      })
    ).resolves.toEqual({
      reserved: false,
      reason: "claimed",
      commentId: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a reservation without a valid server timestamp as active", async () => {
    const thread = {
      id: 17,
      comments: [
        { id: 4, content: "@pullfrog explain this" },
        {
          id: 5,
          parentCommentId: 4,
          content: reservationMarker(17, 4, "claim-other"),
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(thread))
    );

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reserveThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        claimId: "claim-mine1",
        now: new Date("2026-10-05T06:00:00Z"),
        settleMs: 0,
      })
    ).resolves.toMatchObject({
      reserved: false,
      reason: "claimed",
      commentId: 5,
    });
  });

  it("reclaims an expired reservation and acquires a new lease", async () => {
    const thread = {
      id: 17,
      comments: [
        { id: 4, content: "@pullfrog explain this" },
        {
          id: 5,
          parentCommentId: 4,
          content: reservationMarker(17, 4, "claim-stale"),
          publishedDate: "2026-10-05T05:00:00Z",
        },
      ],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17/comments/5?api-version=7.1") && method === "DELETE") {
        thread.comments = thread.comments.filter((comment) => comment.id !== 5);
        return jsonResponse(undefined);
      }
      if (url.endsWith("/threads/17/comments?api-version=7.1") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const posted = {
          id: 6,
          parentCommentId: body.parentCommentId,
          content: body.content,
          publishedDate: "2026-10-05T06:00:00Z",
        };
        thread.comments.push(posted);
        return jsonResponse(posted);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reserveThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        claimId: "claim-mine1",
        now: new Date("2026-10-05T06:00:00Z"),
        leaseMs: 30 * 60 * 1000,
        settleMs: 0,
      })
    ).resolves.toEqual({
      reserved: true,
      reservationCommentId: 6,
      claimId: "claim-mine1",
    });
  });

  it("elects the lowest reservation comment id when workers race", async () => {
    const thread = {
      id: 17,
      comments: [{ id: 4, content: "@pullfrog explain this" }],
    };
    const deleted: number[] = [];
    let reads = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/threads/17?api-version=7.1") && method === "GET") {
        reads += 1;
        return jsonResponse(thread);
      }
      if (url.endsWith("/threads/17/comments?api-version=7.1") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const other = {
          id: 5,
          parentCommentId: 4,
          content: reservationMarker(17, 4, "claim-other"),
          publishedDate: "2026-10-05T06:00:00Z",
        };
        const ours = {
          id: 6,
          parentCommentId: body.parentCommentId,
          content: body.content,
          publishedDate: "2026-10-05T06:00:00Z",
        };
        thread.comments.push(other, ours);
        return jsonResponse(ours);
      }
      if (url.endsWith("/threads/17/comments/6?api-version=7.1") && method === "DELETE") {
        deleted.push(6);
        thread.comments = thread.comments.filter((comment) => comment.id !== 6);
        return jsonResponse(undefined);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reserveThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        claimId: "claim-mine1",
        now: new Date("2026-10-05T06:00:00Z"),
        settleMs: 0,
      })
    ).resolves.toEqual({
      reserved: false,
      reason: "claimed",
      commentId: 5,
    });
    expect(reads).toBe(2);
    expect(deleted).toEqual([6]);
  });

  it("does not reserve a request that already has a final reply", async () => {
    const thread = {
      id: 17,
      comments: [
        { id: 4, content: "@pullfrog explain this" },
        {
          id: 5,
          parentCommentId: 4,
          content:
            "answer\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(thread))
    );

    const client = new AzureDevOpsClient(context());
    await expect(
      client.reserveThreadFollowUp({
        threadId: 17,
        triggerCommentId: 4,
        claimId: "claim-mine1",
        settleMs: 0,
      })
    ).resolves.toEqual({
      reserved: false,
      reason: "handled",
      commentId: 5,
    });
  });

  it("releases only reservations owned by the supplied claim id", async () => {
    const thread = {
      id: 17,
      comments: [
        { id: 4, content: "@pullfrog explain this" },
        {
          id: 5,
          parentCommentId: 4,
          content: reservationMarker(17, 4, "claim-mine1"),
          publishedDate: "2026-10-05T06:00:00Z",
        },
        {
          id: 6,
          parentCommentId: 4,
          content: reservationMarker(17, 4, "claim-other"),
          publishedDate: "2026-10-05T06:00:00Z",
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
      if (url.endsWith("/threads/17/comments/5?api-version=7.1") && method === "DELETE") {
        deleted.push(5);
        return jsonResponse(undefined);
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(context());
    await client.releaseThreadFollowUpReservation({
      threadId: 17,
      triggerCommentId: 4,
      claimId: "claim-mine1",
    });

    expect(deleted).toEqual([5]);
  });
});
