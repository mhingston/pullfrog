import {
  AzureDevOpsRepositoryClient,
  resolveAzureDevOpsRepositoryContext,
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

const source = "0123456789abcdef0123456789abcdef01234567";
const zeros = "0000000000000000000000000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AzureDevOpsRepositoryClient follow-up locks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a deterministic ref per PR/thread/comment", () => {
    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    expect(
      client.followUpLockRef({
        pullRequestId: 42,
        threadId: 17,
        triggerCommentId: 4,
      })
    ).toBe(
      "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4"
    );
  });

  it("acquires the lock only through an all-zero compare-and-swap create", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual([
        {
          name: "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
          oldObjectId: zeros,
          newObjectId: source,
        },
      ]);
      return jsonResponse({
        count: 1,
        value: [
          {
            name: body[0].name,
            oldObjectId: zeros,
            newObjectId: source,
            updateStatus: "succeeded",
            success: true,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(
      client.acquireFollowUpLock({
        pullRequestId: 42,
        threadId: 17,
        triggerCommentId: 4,
        sourceCommitId: source,
      })
    ).resolves.toEqual({
      acquired: true,
      lock: {
        refName:
          "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
        sourceCommitId: source,
      },
    });
  });

  it("treats staleOldObjectId as another worker owning the lock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          value: [
            {
              name:
                "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
              updateStatus: "staleOldObjectId",
              success: false,
            },
          ],
        })
      )
    );

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(
      client.acquireFollowUpLock({
        pullRequestId: 42,
        threadId: 17,
        triggerCommentId: 4,
        sourceCommitId: source,
      })
    ).resolves.toEqual({
      acquired: false,
      reason: "claimed",
      refName:
        "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
    });
  });

  it("fails closed when acquisition has an ambiguous transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset after request");
      })
    );

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(
      client.acquireFollowUpLock({
        pullRequestId: 42,
        threadId: 17,
        triggerCommentId: 4,
        sourceCommitId: source,
      })
    ).rejects.toThrow("connection reset after request");
  });

  it("rejects permission/policy failures instead of treating them as contention", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          value: [
            {
              name:
                "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
              updateStatus: "createBranchPermissionRequired",
              success: false,
              customMessage: "create branch denied",
            },
          ],
        })
      )
    );

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(
      client.acquireFollowUpLock({
        pullRequestId: 42,
        threadId: 17,
        triggerCommentId: 4,
        sourceCommitId: source,
      })
    ).rejects.toThrow("createBranchPermissionRequired");
  });

  it("releases only with the exact source SHA compare-and-swap", async () => {
    const refName =
      "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual([
        {
          name: refName,
          oldObjectId: source,
          newObjectId: zeros,
        },
      ]);
      return jsonResponse([
        {
          name: refName,
          oldObjectId: source,
          newObjectId: zeros,
          updateStatus: "succeeded",
          success: true,
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(
      client.releaseFollowUpLock({
        refName,
        sourceCommitId: source,
      })
    ).resolves.toBeUndefined();
  });

  it("fails closed if release loses its expected-object CAS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          value: [
            {
              name:
                "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
              updateStatus: "staleOldObjectId",
              success: false,
            },
          ],
        })
      )
    );

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(
      client.releaseFollowUpLock({
        refName:
          "refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4",
        sourceCommitId: source,
      })
    ).rejects.toThrow("staleOldObjectId");
  });
});
