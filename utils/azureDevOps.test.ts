import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  azureDevOpsReviewMarker,
  AzureDevOpsClient,
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
