import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  azureDevOpsSourcePushArgs,
  commitAndPushAzureDevOpsSource,
  parseAzureDevOpsPushPermission,
  prepareAzureDevOpsSourceCheckout,
  scrubAzureDevOpsGitCredentials,
  validateAzureDevOpsBranchName,
  type AzureDevOpsGitContext,
} from "./azureDevOpsGit.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "pullfrog-azdo-write-test-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "pullfrog@example.invalid"]);
  git(root, ["config", "user.name", "Pullfrog Test"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["branch", "-M", "feature/write"]);
  git(root, [
    "remote",
    "add",
    "origin",
    "https://dev.azure.com/acme/Platform/_git/widget",
  ]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]).toLowerCase() };
}

function context(sha: string): AzureDevOpsGitContext {
  return {
    collectionUri: "https://dev.azure.com/acme/",
    repositoryUri: "https://dev.azure.com/acme/Platform/_git/widget",
    sourceBranch: "feature/write",
    sourceCommitId: sha,
    targetBranch: "main",
    authorization: "Bearer secret-test-token",
  };
}

describe("Azure DevOps push permission", () => {
  it("defaults to restricted and accepts the GitHub-compatible vocabulary", () => {
    expect(parseAzureDevOpsPushPermission(undefined)).toBe("restricted");
    expect(parseAzureDevOpsPushPermission("disabled")).toBe("disabled");
    expect(parseAzureDevOpsPushPermission("restricted")).toBe("restricted");
    expect(parseAzureDevOpsPushPermission("enabled")).toBe("enabled");
  });

  it("rejects unknown permission modes", () => {
    expect(() => parseAzureDevOpsPushPermission("force")).toThrow(
      "disabled, restricted, or enabled"
    );
  });
});

describe("Azure DevOps source push lease", () => {
  it("pins the remote ref to the validated source SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(azureDevOpsSourcePushArgs("feature/write", sha)).toEqual([
      "--force-with-lease=refs/heads/feature/write:" + sha,
      "HEAD:refs/heads/feature/write",
    ]);
  });
});

describe("Azure DevOps branch validation", () => {
  it("accepts ordinary feature branches", () => {
    expect(validateAzureDevOpsBranchName("feature/fix-123")).toBe("feature/fix-123");
  });

  it.each([
    "refs/heads/main",
    "HEAD",
    "--upload-pack=evil",
    "feature:refs/heads/main",
    "+main",
  ])("rejects ref/refspec-shaped branch %s", (branch) => {
    expect(() => validateAzureDevOpsBranchName(branch)).toThrow();
  });
});

describe("Azure DevOps credential isolation", () => {
  it("removes checkout-persisted auth and credential helpers from local config", () => {
    const { root } = makeRepo();
    try {
      git(root, [
        "config",
        "--local",
        "http.https://dev.azure.com/acme.extraheader",
        "AUTHORIZATION: bearer leaked",
      ]);
      git(root, ["config", "--local", "credential.helper", "store"]);

      scrubAzureDevOpsGitCredentials(root);

      const remaining = execFileSync("git", ["config", "--local", "--list"], {
        cwd: root,
        encoding: "utf-8",
      });
      expect(remaining).not.toContain("extraheader");
      expect(remaining).not.toContain("credential.helper");
      expect(remaining).not.toContain("leaked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not leave a disabled run with a prepared writable checkout", () => {
    const { root, sha } = makeRepo();
    try {
      expect(() =>
        prepareAzureDevOpsSourceCheckout({
          cwd: root,
          ctx: context(sha),
          permission: "disabled",
        })
      ).toThrow("push is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Azure DevOps stale write guards", () => {
  it("fails before authenticated git when the live PR source advanced", async () => {
    const { root, sha } = makeRepo();
    const newer = "fedcba9876543210fedcba9876543210fedcba98";
    try {
      writeFileSync(join(root, "base.txt"), "changed\n");

      await expect(
        commitAndPushAzureDevOpsSource({
          cwd: root,
          ctx: context(sha),
          permission: "restricted",
          message: "fix: update base",
          getLiveSourceCommitId: async () => newer,
        })
      ).rejects.toThrow("PR source advanced");

      expect(git(root, ["rev-parse", "HEAD"]).toLowerCase()).toBe(sha);
      expect(git(root, ["status", "--porcelain"])).toContain("base.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a local commit the parent process did not create", async () => {
    const { root, sha } = makeRepo();
    try {
      writeFileSync(join(root, "base.txt"), "changed\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "agent-created commit"]);

      await expect(
        commitAndPushAzureDevOpsSource({
          cwd: root,
          ctx: context(sha),
          permission: "restricted",
          message: "fix: update base",
          getLiveSourceCommitId: async () => sha,
        })
      ).rejects.toThrow("Pullfrog owns the commit step");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks target-branch writes even when enabled is requested", () => {
    const { root, sha } = makeRepo();
    try {
      expect(() =>
        prepareAzureDevOpsSourceCheckout({
          cwd: root,
          ctx: {
            ...context(sha),
            sourceBranch: "main",
            targetBranch: "main",
          },
          permission: "enabled",
        })
      ).toThrow("same as the target branch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
