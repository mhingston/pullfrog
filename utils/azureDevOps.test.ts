import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AZDO_REVIEW_MARKER,
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
  SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
  SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature/azdo",
  SYSTEM_PULLREQUEST_SOURCECOMMITID: "0123456789abcdef",
  SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
  SYSTEM_ACCESSTOKEN: "job-token",
} satisfies NodeJS.ProcessEnv;

describe("Azure DevOps context", () => {
  it("normalizes Azure Pipelines PR variables", () => {
    expect(resolveAzureDevOpsContext(baseEnv)).toEqual({
      collectionUri: "https://dev.azure.com/acme/",
      project: "Platform",
      repositoryId: "repo-guid",
      pullRequestId: 42,
      sourceBranch: "feature/azdo",
      sourceCommitId: "0123456789abcdef",
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates the existing Pullfrog review instead of duplicating it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 7,
                comments: [{ id: 9, content: "old review\n\n" + AZDO_REVIEW_MARKER }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 9 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(client.upsertReviewThread("new review")).resolves.toEqual({
      created: false,
      threadId: 7,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain(
      "/pullRequests/42/threads/7/comments/9?api-version=7.1"
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.content).toContain("new review");
    expect(body.content).toContain(AZDO_REVIEW_MARKER);
  });

  it("creates a general PR thread when no Pullfrog review exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 11 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsClient(resolveAzureDevOpsContext(baseEnv));
    await expect(client.upsertReviewThread("review body")).resolves.toEqual({
      created: true,
      threadId: 11,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("/pullRequests/42/threads?api-version=7.1");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.comments[0].content).toContain(AZDO_REVIEW_MARKER);
    expect(body.status).toBe(1);
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
