import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  azureDevOpsBranchOwnershipBranch,
  azureDevOpsReviewMarker,
  AzureDevOpsClient,
  AzureDevOpsRepositoryClient,
  buildAzureDevOpsAuthorization,
  buildAzureDevOpsPullRequestDiff,
  resolveAzureDevOpsContext,
  stripRefsHeads,
} from "./azureDevOps.ts";

const baseEnv = {
  SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme",
  SYSTEM_TEAMPROJECT: "Platform",
  BUILD_REPOSITORY_ID: "repo-guid",
  BUILD_REPOSITORY_URI: "https://dev.azure.com/acme/Platform/_git/widget",
  BUILD_REPOSITORY_DEFAULTBRANCH: "refs/heads/main",
  BUILD_REPOSITORY_PROVIDER: "TfsGit",
  SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
  SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature/azdo",
  SYSTEM_PULLREQUEST_SOURCECOMMITID: "0123456789abcdef0123456789abcdef01234567",
  SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
  SYSTEM_ACCESSTOKEN: "job-token",
} satisfies NodeJS.ProcessEnv;

describe("Azure DevOps context", () => {
  it("normalizes Azure Pipelines PR variables", () => {
    expect(resolveAzureDevOpsContext(baseEnv)).toEqual({
      collectionUri: "https://dev.azure.com/acme/",
      project: "Platform",
      repositoryId: "repo-guid",
      repositoryUri: "https://dev.azure.com/acme/Platform/_git/widget",
      defaultBranch: "main",
      pullRequestId: 42,
      sourceBranch: "feature/azdo",
      sourceCommitId: "0123456789abcdef0123456789abcdef01234567",
      targetBranch: "main",
      authorization: "Bearer job-token",
    });
  });

  it("accepts a PAT fallback", () => {
    expect(
      buildAzureDevOpsAuthorization({
        AZURE_DEVOPS_PAT: "secret",
      })
    ).toBe("Basic " + Buffer.from(":secret").toString("base64"));
  });

  it("prefers the pipeline job token over PAT", () => {
    expect(
      buildAzureDevOpsAuthorization({
        SYSTEM_ACCESSTOKEN: "job-token",
        AZURE_DEVOPS_PAT: "secret",
      })
    ).toBe("Bearer job-token");
  });

  it("strips only refs/heads", () => {
    expect(stripRefsHeads("refs/heads/users/mark/feature")).toBe("users/mark/feature");
    expect(stripRefsHeads("main")).toBe("main");
  });


  it("rejects non-Azure-Repos providers", () => {
    expect(() =>
      resolveAzureDevOpsContext({
        ...baseEnv,
        BUILD_REPOSITORY_PROVIDER: "GitHub",
      })
    ).toThrow("Azure Repos Git only");
  });

  it("fails clearly outside a PR validation build", () => {
    expect(() =>
      resolveAzureDevOpsContext({
        ...baseEnv,
        SYSTEM_PULLREQUEST_PULLREQUESTID: undefined,
      })
    ).toThrow("SYSTEM_PULLREQUEST_PULLREQUESTID");
  });
});

describe("AzureDevOpsClient.updatePullRequestDescription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stale-checks then PATCHes only the current PR description with parent-owned authorization", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      expect(url).toBe(
        "https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid/pullRequests/42?api-version=7.1"
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer job-token");

      if (method === "GET") {
        return new Response(
          JSON.stringify({
            pullRequestId: 42,
            title: "Azure PR",
            description: "old description",
            sourceRefName: "refs/heads/feature/azdo",
            targetRefName: "refs/heads/main",
            lastMergeSourceCommit: {
              commitId: baseEnv.SYSTEM_PULLREQUEST_SOURCECOMMITID,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      expect(method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        description: "updated description",
      });
      return new Response(
        JSON.stringify({
          pullRequestId: 42,
          title: "Azure PR",
          description: "updated description",
          sourceRefName: "refs/heads/feature/azdo",
          targetRefName: "refs/heads/main",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.updatePullRequestDescription(
        "updated description",
        baseEnv.SYSTEM_PULLREQUEST_SOURCECOMMITID
      )
    ).resolves.toMatchObject({
      pullRequestId: 42,
      description: "updated description",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Azure DevOps safe PR mutations", () => {
  const sourceCommitId = baseEnv.SYSTEM_PULLREQUEST_SOURCECOMMITID;
  const targetCommitId = "1111111111111111111111111111111111111111";
  const newerCommitId = "fedcba9876543210fedcba9876543210fedcba98";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("rejects a stale current-PR description update before PATCH", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      expect(method).toBe("GET");
      expect(url).toContain("/pullRequests/42?api-version=7.1");
      return jsonResponse({
        lastMergeSourceCommit: { commitId: newerCommitId },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(
      client.updatePullRequestDescription("new description", sourceCommitId)
    ).rejects.toThrow("source advanced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("atomically creates a Pullfrog branch and ownership proof", async () => {
    const branchName = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(branchName);
    const refPosts: unknown[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/refs?filter=heads%2Fmain")) {
        return jsonResponse({
          value: [{ name: "refs/heads/main", objectId: targetCommitId }],
        });
      }
      if (url.endsWith("/refs?api-version=7.1") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        refPosts.push(body);
        return jsonResponse([
          {
            name: body[0]?.name,
            oldObjectId: "0".repeat(40),
            newObjectId: targetCommitId,
            updateStatus: "succeeded",
            success: true,
          },
        ]);
      }
      if (
        url.includes("/refs?filter=" + encodeURIComponent("heads/" + branchName))
      ) {
        return jsonResponse({
          value: [{ name: "refs/heads/" + branchName, objectId: targetCommitId }],
        });
      }
      if (
        url.includes(
          "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
        )
      ) {
        return jsonResponse({
          value: [{
            name: "refs/heads/" + ownershipBranch,
            objectId: targetCommitId,
          }],
        });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullfrogBranch({
        branch: branchName,
        targetBranch: "main",
        expectedTargetCommitId: targetCommitId,
        permission: "enabled",
      })
    ).resolves.toEqual({
      branch: branchName,
      sha: targetCommitId,
      ownershipBranch,
    });

    expect(refPosts).toHaveLength(2);
  });

  it("requires enabled permission for new Pullfrog branches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );

    await expect(
      client.createPullfrogBranch({
        branch: "pullfrog/branches/fix-42",
        targetBranch: "main",
        permission: "restricted",
      })
    ).rejects.toThrow("requires enabled push permission");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a PR only after validating ownership, source, and target refs", async () => {
    const sourceBranch = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(sourceBranch);
    const targetBranch = "main";
    const seenBodies: unknown[] = [];
    let sourceReads = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        url.includes(
          "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
        )
      ) {
        return jsonResponse({
          value: [{
            name: "refs/heads/" + ownershipBranch,
            objectId: targetCommitId,
          }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fpullfrog%2Fbranches%2Ffix-42")) {
        sourceReads += 1;
        return jsonResponse({
          value: [{ name: "refs/heads/" + sourceBranch, objectId: sourceCommitId }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fmain")) {
        return jsonResponse({
          value: [{ name: "refs/heads/main", objectId: targetCommitId }],
        });
      }
      if (url.endsWith("/pullrequests?api-version=7.1") && method === "POST") {
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix CI",
          description: "Repair failing validation",
          repository: { id: "repo-guid" },
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/main",
          lastMergeSourceCommit: { commitId: sourceCommitId },
        });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch,
        sourceCommitId,
        targetBranch,
        title: "Fix CI",
        description: "Repair failing validation",
        permission: "enabled",
      })
    ).resolves.toMatchObject({
      pullRequestId: 77,
      sourceRefName: "refs/heads/" + sourceBranch,
      targetRefName: "refs/heads/main",
    });

    expect(sourceReads).toBe(2);
    expect(seenBodies).toEqual([
      {
        sourceRefName: "refs/heads/" + sourceBranch,
        targetRefName: "refs/heads/main",
        title: "Fix CI",
        description: "Repair failing validation",
      },
    ]);
  });

  it("requires enabled permission and the reserved Pullfrog branch namespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );

    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch: "pullfrog/branches/fix-42",
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "restricted",
      })
    ).rejects.toThrow("requires enabled push permission");

    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch: "users/mark/fix-42",
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("pullfrog/branches/");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Azure PR titles over 400 characters before any API call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );

    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch: "pullfrog/branches/fix-42",
        sourceCommitId,
        targetBranch: "main",
        title: "x".repeat(401),
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("400 characters or fewer");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never allows the repository default branch as a PR source", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      ...resolveAzureDevOpsContext(baseEnv),
      defaultBranch: "pullfrog/branches/default",
    };
    const client = new AzureDevOpsRepositoryClient(ctx);

    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch: "pullfrog/branches/default",
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("repository default branch");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects PR creation when Pullfrog ownership proof is missing", async () => {
    const sourceBranch = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(sourceBranch);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(
        "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
      );
      return jsonResponse({ value: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch,
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("ownership proof is missing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the source branch moved before PR creation", async () => {
    const sourceBranch = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(sourceBranch);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = String(input);
      if (
        url.includes(
          "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
        )
      ) {
        return jsonResponse({
          value: [{
            name: "refs/heads/" + ownershipBranch,
            objectId: targetCommitId,
          }],
        });
      }
      return jsonResponse({
        value: [{ name: "refs/heads/" + sourceBranch, objectId: newerCommitId }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch,
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("source branch advanced");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("abandons a created PR when returned refs fail validation", async () => {
    const sourceBranch = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(sourceBranch);
    let abandoned = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        url.includes(
          "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
        )
      ) {
        return jsonResponse({
          value: [{
            name: "refs/heads/" + ownershipBranch,
            objectId: targetCommitId,
          }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fpullfrog%2Fbranches%2Ffix-42")) {
        return jsonResponse({
          value: [{ name: "refs/heads/" + sourceBranch, objectId: sourceCommitId }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fmain")) {
        return jsonResponse({
          value: [{ name: "refs/heads/main", objectId: targetCommitId }],
        });
      }
      if (url.endsWith("/pullrequests?api-version=7.1") && method === "POST") {
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix",
          description: "",
          repository: { id: "repo-guid" },
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/release",
        });
      }
      if (
        url.endsWith("/pullrequests/77?api-version=7.1") &&
        method === "PATCH"
      ) {
        abandoned = true;
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix",
          description: "",
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/release",
        });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch,
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("unexpected source/target refs");
    expect(abandoned).toBe(true);
  });

  it("abandons a created PR when final source verification errors", async () => {
    const sourceBranch = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(sourceBranch);
    let sourceReads = 0;
    let abandoned = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        url.includes(
          "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
        )
      ) {
        return jsonResponse({
          value: [{
            name: "refs/heads/" + ownershipBranch,
            objectId: targetCommitId,
          }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fpullfrog%2Fbranches%2Ffix-42")) {
        sourceReads += 1;
        if (sourceReads > 1) throw new Error("simulated ref read failure");
        return jsonResponse({
          value: [{ name: "refs/heads/" + sourceBranch, objectId: sourceCommitId }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fmain")) {
        return jsonResponse({
          value: [{ name: "refs/heads/main", objectId: targetCommitId }],
        });
      }
      if (url.endsWith("/pullrequests?api-version=7.1") && method === "POST") {
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix",
          description: "",
          repository: { id: "repo-guid" },
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/main",
        });
      }
      if (
        url.endsWith("/pullrequests/77?api-version=7.1") &&
        method === "PATCH"
      ) {
        abandoned = true;
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix",
          description: "",
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/main",
        });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch,
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("simulated ref read failure");
    expect(abandoned).toBe(true);
  });

  it("abandons a just-created PR if the source moves during creation", async () => {
    const sourceBranch = "pullfrog/branches/fix-42";
    const ownershipBranch = azureDevOpsBranchOwnershipBranch(sourceBranch);
    let sourceReads = 0;
    let abandoned = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        url.includes(
          "/refs?filter=" + encodeURIComponent("heads/" + ownershipBranch)
        )
      ) {
        return jsonResponse({
          value: [{
            name: "refs/heads/" + ownershipBranch,
            objectId: targetCommitId,
          }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fpullfrog%2Fbranches%2Ffix-42")) {
        sourceReads += 1;
        return jsonResponse({
          value: [{
            name: "refs/heads/" + sourceBranch,
            objectId: sourceReads === 1 ? sourceCommitId : newerCommitId,
          }],
        });
      }
      if (url.includes("/refs?filter=heads%2Fmain")) {
        return jsonResponse({
          value: [{ name: "refs/heads/main", objectId: targetCommitId }],
        });
      }
      if (url.endsWith("/pullrequests?api-version=7.1") && method === "POST") {
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix",
          description: "",
          repository: { id: "repo-guid" },
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/main",
        });
      }
      if (
        url.endsWith("/pullrequests/77?api-version=7.1") &&
        method === "PATCH"
      ) {
        expect(JSON.parse(String(init?.body))).toEqual({ status: "abandoned" });
        abandoned = true;
        return jsonResponse({
          pullRequestId: 77,
          title: "Fix",
          description: "",
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/main",
        });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsContext(baseEnv)
    );
    await expect(
      client.createPullRequestFromPullfrogBranch({
        sourceBranch,
        sourceCommitId,
        targetBranch: "main",
        title: "Fix",
        description: "",
        permission: "enabled",
      })
    ).rejects.toThrow("was abandoned");
    expect(abandoned).toBe(true);
  });
});

describe("AzureDevOpsClient.upsertReviewThread", () => {
  const sourceCommitId = baseEnv.SYSTEM_PULLREQUEST_SOURCECOMMITID;
  const marker = azureDevOpsReviewMarker(sourceCommitId);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("updates the existing current-source Pullfrog review instead of duplicating it", async () => {
    const threads = [
      {
        id: 7,
        status: 1,
        comments: [{ id: 9, content: "old review\n\n" + marker }],
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: sourceCommitId } });
      }
      if (url.endsWith("/pullRequests/42/threads?api-version=7.1") && method === "GET") {
        return jsonResponse({ value: threads });
      }
      if (url.includes("/threads/7/comments/9?api-version=7.1") && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        threads[0]!.comments[0]!.content = body.content;
        return jsonResponse({ id: 9 });
      }
      if (url.endsWith("/threads/7?api-version=7.1") && method === "PATCH") {
        return jsonResponse({ id: 7 });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(client.upsertReviewThread("new review", sourceCommitId)).resolves.toEqual({
      published: true,
      created: false,
      threadId: 7,
    });

    expect(threads[0]!.comments[0]!.content).toContain("new review");
    expect(threads[0]!.comments[0]!.content).toContain(marker);
  });

  it("skips publication when the PR has advanced to a newer source commit", async () => {
    const newer = "fedcba9876543210fedcba9876543210fedcba98";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: newer } });
      }
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(client.upsertReviewThread("stale review", sourceCommitId)).resolves.toEqual({
      published: false,
      supersededBy: newer,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("converges same-source duplicate threads onto the lowest thread id", async () => {
    const threads = [
      {
        id: 11,
        status: 1,
        comments: [{ id: 21, content: "review A\n\n" + marker }],
      },
      {
        id: 12,
        status: 1,
        comments: [{ id: 22, content: "review B\n\n" + marker }],
      },
    ];
    const statuses = new Map<number, number>();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/pullRequests/42?api-version=7.1")) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: sourceCommitId } });
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
    await expect(client.upsertReviewThread("canonical review", sourceCommitId)).resolves.toEqual({
      published: true,
      created: false,
      threadId: 11,
    });

    expect(statuses.get(11)).toBe(1);
    expect(statuses.get(12)).toBe(4);
    expect(threads[0]!.comments[0]!.content).toContain("canonical review");
  });
});


describe("buildAzureDevOpsPullRequestDiff", () => {
  it("reviews the PR source commit rather than a synthetic validation merge HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "pullfrog-azdo-test-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");

    const git = (cwd: string, args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

    try {
      execFileSync("git", ["init", "--bare", remote]);
      mkdirSync(work);
      git(work, ["init"]);
      git(work, ["config", "user.email", "pullfrog@example.invalid"]);
      git(work, ["config", "user.name", "Pullfrog Test"]);

      writeFileSync(join(work, "base.txt"), "base\n");
      git(work, ["add", "."]);
      git(work, ["commit", "-m", "base"]);
      git(work, ["branch", "-M", "main"]);
      git(work, ["remote", "add", "origin", remote]);
      git(work, ["push", "-u", "origin", "main"]);

      git(work, ["checkout", "-b", "feature/azdo"]);
      writeFileSync(join(work, "feature.txt"), "feature change\n");
      git(work, ["add", "."]);
      git(work, ["commit", "-m", "feature"]);
      const sourceCommitId = git(work, ["rev-parse", "HEAD"]);
      git(work, ["push", "-u", "origin", "feature/azdo"]);

      git(work, ["checkout", "main"]);
      writeFileSync(join(work, "target-only.txt"), "target moved\n");
      git(work, ["add", "."]);
      git(work, ["commit", "-m", "target moved"]);
      git(work, ["push", "origin", "main"]);

      git(work, ["checkout", "feature/azdo"]);
      git(work, ["merge", "--no-edit", "main"]);

      const result = buildAzureDevOpsPullRequestDiff({
        cwd: work,
        sourceBranch: "feature/azdo",
        sourceCommitId,
        targetBranch: "main",
      });

      expect(result.diff).toContain("feature.txt");
      expect(result.diff).toContain("feature change");
      expect(result.diff).not.toContain("target-only.txt");
      expect(result.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
