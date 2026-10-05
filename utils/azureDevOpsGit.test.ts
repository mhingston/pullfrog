import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAzureDevOpsMergeConfigSafe,
  azureDevOpsSourcePushArgs,
  commitAndPushAzureDevOpsMergeResolution,
  commitAndPushAzureDevOpsPullfrogBranch,
  commitAndPushAzureDevOpsSource,
  parseAzureDevOpsPushPermission,
  prepareAzureDevOpsPullfrogBranchCheckout,
  prepareAzureDevOpsSourceCheckout,
  scrubAzureDevOpsGitCredentials,
  validateAzureDevOpsBranchName,
  validateAzureDevOpsPullfrogBranch,
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
    defaultBranch: "main",
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

describe("Azure DevOps enabled branch ownership", () => {
  it("accepts only the reserved Pullfrog branch namespace", () => {
    expect(
      validateAzureDevOpsPullfrogBranch("pullfrog/branches/fix-123")
    ).toBe("pullfrog/branches/fix-123");
    expect(() =>
      validateAzureDevOpsPullfrogBranch("feature/fix-123")
    ).toThrow("pullfrog/branches/");
  });

  it("blocks an enabled owned-branch commit when ownership proof is missing", async () => {
    const { root, sha } = makeRepo();
    const ownedCtx = {
      ...context(sha),
      sourceBranch: "pullfrog/branches/fix-123",
    };
    try {
      await expect(
        commitAndPushAzureDevOpsPullfrogBranch({
          cwd: root,
          ctx: ownedCtx,
          permission: "enabled",
          message: "fix: test",
          getLiveSourceCommitId: async () => sha,
          verifyOwnership: async () => false,
        })
      ).rejects.toThrow("ownership proof is missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires enabled mode before preparing or committing an owned branch", async () => {
    const { root, sha } = makeRepo();
    const ownedCtx = {
      ...context(sha),
      sourceBranch: "pullfrog/branches/fix-123",
    };
    try {
      expect(() =>
        prepareAzureDevOpsPullfrogBranchCheckout({
          cwd: root,
          ctx: ownedCtx,
          permission: "restricted",
        })
      ).toThrow("requires enabled push access");

      await expect(
        commitAndPushAzureDevOpsPullfrogBranch({
          cwd: root,
          ctx: ownedCtx,
          permission: "restricted",
          message: "fix: test",
          getLiveSourceCommitId: async () => sha,
          verifyOwnership: async () => true,
        })
      ).rejects.toThrow("requires enabled push access");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Azure DevOps merge repair safety", () => {
  it("rejects local executable merge/filter configuration", () => {
    const { root } = makeRepo();
    try {
      git(root, ["config", "--local", "merge.evil.driver", "sh -c 'touch /tmp/pwned'"]);
      expect(() => assertAzureDevOpsMergeConfigSafe(root)).toThrow(
        "executable/local merge config"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks finalization while conflict markers remain in an expected conflict file", async () => {
    const { root, sha } = makeRepo();
    try {
      git(root, ["checkout", "-b", "target-for-test", sha]);
      writeFileSync(join(root, "target.txt"), "target\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "target"]);
      const targetSha = git(root, ["rev-parse", "HEAD"]).toLowerCase();
      git(root, ["checkout", "feature/write"]);
      writeFileSync(
        join(root, "base.txt"),
        "<<<<<<< HEAD\nsource\n=======\ntarget\n>>>>>>> target\n"
      );
      writeFileSync(join(root, ".git", "MERGE_HEAD"), targetSha + "\n");

      await expect(
        commitAndPushAzureDevOpsMergeResolution({
          cwd: root,
          ctx: context(sha),
          permission: "restricted",
          message: "fix: resolve merge",
          targetSha,
          conflictedFiles: ["base.txt"],
          getLiveSourceCommitId: async () => sha,
          getLiveTargetCommitId: async () => targetSha,
        })
      ).rejects.toThrow("conflict markers remain in base.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the target moves during conflict resolution", async () => {
    const { root, sha } = makeRepo();
    try {
      git(root, ["checkout", "-b", "target-for-test", sha]);
      writeFileSync(join(root, "target.txt"), "target\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "target"]);
      const targetSha = git(root, ["rev-parse", "HEAD"]).toLowerCase();
      git(root, ["checkout", "feature/write"]);
      writeFileSync(join(root, ".git", "MERGE_HEAD"), targetSha + "\n");

      await expect(
        commitAndPushAzureDevOpsMergeResolution({
          cwd: root,
          ctx: context(sha),
          permission: "restricted",
          message: "fix: resolve merge",
          targetSha,
          conflictedFiles: [],
          getLiveSourceCommitId: async () => sha,
          getLiveTargetCommitId: async () =>
            "fedcba9876543210fedcba9876543210fedcba98",
        })
      ).rejects.toThrow("target moved during conflict resolution");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("blocks writes from the repository default branch even when it targets another branch", () => {
    const { root, sha } = makeRepo();
    try {
      expect(() =>
        prepareAzureDevOpsSourceCheckout({
          cwd: root,
          ctx: {
            ...context(sha),
            sourceBranch: "main",
            targetBranch: "release/2026",
          },
          permission: "enabled",
        })
      ).toThrow("repository default branch main");
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
