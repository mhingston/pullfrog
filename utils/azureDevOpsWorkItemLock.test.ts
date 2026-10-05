import {
  AzureDevOpsRepositoryClient,
  type AzureDevOpsRepositoryContext,
} from "./azureDevOps.ts";

const ctx: AzureDevOpsRepositoryContext = {
  collectionUri: "https://dev.azure.com/acme/",
  project: "Platform",
  repositoryId: "repo-guid",
  repositoryUri: "https://dev.azure.com/acme/Platform/_git/widget",
  defaultBranch: "main",
  authorization: "Bearer job-token",
};

const anchor = "0123456789abcdef0123456789abcdef01234567";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Azure work-item coordination locks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses immutable work-item/revision/comment identity in the reserved lock namespace", () => {
    const client = new AzureDevOpsRepositoryClient(ctx);
    expect(
      client.workItemLockRef({
        workItemId: 42,
        commentId: 9,
      })
    ).toBe(
      "refs/heads/pullfrog/locks/work-item/wi-42-comment-9"
    );
    expect(
      client.workItemLockRef({
        workItemId: 42,
      })
    ).toBe(
      "refs/heads/pullfrog/locks/work-item/wi-42-created"
    );
  });

  it("acquires by all-zero CAS and releases with the exact anchor commit", async () => {
    const writes: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      const update = body[0];
      return jsonResponse([
        {
          name: update.name,
          oldObjectId: update.oldObjectId,
          newObjectId: update.newObjectId,
          updateStatus: "succeeded",
          success: true,
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(ctx);
    const acquired = await client.acquireWorkItemLock({
      workItemId: 42,
      commentId: 9,
      anchorCommitId: anchor,
    });
    expect(acquired).toEqual({
      acquired: true,
      lock: {
        refName:
          "refs/heads/pullfrog/locks/work-item/wi-42-comment-9",
        anchorCommitId: anchor,
      },
    });
    if (!acquired.acquired) throw new Error("expected lock");

    await client.releaseWorkItemLock(acquired.lock);

    expect(writes).toEqual([
      [
        {
          name:
            "refs/heads/pullfrog/locks/work-item/wi-42-comment-9",
          oldObjectId: "0".repeat(40),
          newObjectId: anchor,
        },
      ],
      [
        {
          name:
            "refs/heads/pullfrog/locks/work-item/wi-42-comment-9",
          oldObjectId: anchor,
          newObjectId: "0".repeat(40),
        },
      ],
    ]);
  });

  it("treats CAS contention as claimed instead of guessing ownership", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            updateStatus: "staleOldObjectId",
            success: false,
          },
        ])
      )
    );
    const client = new AzureDevOpsRepositoryClient(ctx);
    await expect(
      client.acquireWorkItemLock({
        workItemId: 42,
        anchorCommitId: anchor,
      })
    ).resolves.toEqual({
      acquired: false,
      reason: "claimed",
      refName:
        "refs/heads/pullfrog/locks/work-item/wi-42-created",
    });
  });
});
