import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AzureDevOpsPushPermission = "disabled" | "restricted" | "enabled";

export interface AzureDevOpsGitContext {
  collectionUri: string;
  repositoryUri: string;
  sourceBranch: string;
  sourceCommitId: string;
  targetBranch: string;
  authorization: string;
}

export interface AzureDevOpsWriteResult {
  branch: string;
  previousSha: string;
  pushedSha: string;
  files: string[];
}

const SENSITIVE_GIT_ENV = [
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_CONFIG_PARAMETERS",
] as const;

function credentialFreeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.SYSTEM_ACCESSTOKEN;
  delete env.AZURE_DEVOPS_TOKEN;
  delete env.AZURE_DEVOPS_PAT;
  for (const name of SENSITIVE_GIT_ENV) delete env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = "0";
  env.GIT_CONFIG_PARAMETERS = "";
  return env;
}

function git(cwd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    env: credentialFreeEnv(options?.env),
  }).trimEnd();
}

function normalizeRepositoryUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Azure DevOps repository URL is invalid: " + raw);
  }
  if (url.protocol !== "https:") {
    throw new Error("Azure DevOps git writes require an https repository URL");
  }
  if (url.password) {
    throw new Error("Azure DevOps repository URL must not contain an embedded password");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "").toLowerCase();
}

function assertExpectedRepository(cwd: string, ctx: AzureDevOpsGitContext): string {
  const expected = normalizeRepositoryUrl(ctx.repositoryUri);
  const configuredRaw = git(cwd, ["config", "--local", "--get", "remote.origin.url"]);
  const configured = normalizeRepositoryUrl(configuredRaw);
  if (configured !== expected) {
    throw new Error(
      "Azure DevOps git write blocked: origin does not match BUILD_REPOSITORY_URI. " +
        "Expected " +
        ctx.repositoryUri +
        ", found " +
        configuredRaw
    );
  }

  const collectionHost = new URL(ctx.collectionUri).hostname.toLowerCase();
  const repoHost = new URL(ctx.repositoryUri).hostname.toLowerCase();
  if (collectionHost !== repoHost) {
    throw new Error(
      "Azure DevOps git write blocked: repository host does not match collection host"
    );
  }

  return ctx.repositoryUri;
}

export function validateAzureDevOpsBranchName(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Azure DevOps branch name is empty");
  if (trimmed.startsWith("-") || trimmed.startsWith("refs/")) {
    throw new Error("Azure DevOps branch must be a bare branch name: " + branch);
  }
  if (["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"].includes(trimmed)) {
    throw new Error("Azure DevOps branch cannot be a symbolic git ref: " + branch);
  }
  if (/[:+^~?*[\\\s]/.test(trimmed)) {
    throw new Error("Azure DevOps branch contains git refspec/revision syntax: " + branch);
  }
  try {
    git(process.cwd(), ["check-ref-format", "--branch", trimmed]);
  } catch {
    throw new Error("Azure DevOps branch is not a valid git branch name: " + branch);
  }
  return trimmed;
}

export function parseAzureDevOpsPushPermission(
  raw: string | undefined,
  fallback: AzureDevOpsPushPermission = "restricted"
): AzureDevOpsPushPermission {
  const value = raw?.trim().toLowerCase() || fallback;
  if (value !== "disabled" && value !== "restricted" && value !== "enabled") {
    throw new Error(
      "Azure DevOps push permission must be disabled, restricted, or enabled; received: " +
        value
    );
  }
  return value;
}

function localConfigKeys(cwd: string, pattern: string): string[] {
  const result = spawnSync("git", ["config", "--local", "--name-only", "--get-regexp", pattern], {
    cwd,
    encoding: "utf-8",
    env: credentialFreeEnv(),
  });
  if (result.status === 1) return [];
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "failed to inspect git config: " + String(result.stderr || result.stdout || "").trim()
    );
  }
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function scrubAzureDevOpsGitCredentials(cwd: string): void {
  const keys = new Set([
    ...localConfigKeys(cwd, "^http\\..*\\.extraheader$"),
    ...localConfigKeys(cwd, "^credential\\."),
  ]);
  for (const key of keys) {
    const result = spawnSync("git", ["config", "--local", "--unset-all", key], {
      cwd,
      encoding: "utf-8",
      env: credentialFreeEnv(),
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 5) {
      throw new Error(
        "failed to remove persisted Azure git credential config " +
          key +
          ": " +
          String(result.stderr || result.stdout || "").trim()
      );
    }
  }
}

function assertNoDangerousAuthenticatedGitConfig(cwd: string): void {
  const dangerous = [
    ...localConfigKeys(cwd, "^url\\..*\\.insteadof$"),
    ...localConfigKeys(cwd, "^remote\\..*\\.(uploadpack|receivepack)$"),
    ...localConfigKeys(cwd, "^core\\.(hookspath|sshcommand)$"),
  ];
  if (dangerous.length > 0) {
    throw new Error(
      "Azure DevOps authenticated git blocked by unsafe local git config: " +
        dangerous.join(", ")
    );
  }
}

function authenticatedGit(
  cwd: string,
  ctx: AzureDevOpsGitContext,
  subcommand: "fetch" | "push",
  args: string[]
): string {
  const repositoryUri = assertExpectedRepository(cwd, ctx);
  assertNoDangerousAuthenticatedGitConfig(cwd);

  const isolated = mkdtempSync(join(tmpdir(), "pullfrog-azdo-git-"));
  const hooksDir = join(isolated, "hooks");
  const homeDir = join(isolated, "home");
  mkdirSync(hooksDir);
  mkdirSync(homeDir);

  const env = credentialFreeEnv({
    HOME: homeDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(isolated, "global.gitconfig"),
    PULLFROG_AZDO_GIT_HEADER: "AUTHORIZATION: " + ctx.authorization,
  });

  const fullArgs = [
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=" + hooksDir,
    "--config-env=http.extraheader=PULLFROG_AZDO_GIT_HEADER",
    subcommand,
    repositoryUri,
    ...args,
  ];

  try {
    const result = spawnSync("git", fullArgs, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      throw new Error(
        "Azure DevOps git " +
          subcommand +
          " failed (exit " +
          result.status +
          ")" +
          (detail ? ": " + detail : "")
      );
    }
    return String(result.stdout || "").trim();
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

function remoteTrackingRef(branch: string): string {
  return "refs/remotes/origin/" + branch;
}

export function fetchAzureDevOpsBranch(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  branch: string;
}): string {
  const branch = validateAzureDevOpsBranchName(params.branch);
  scrubAzureDevOpsGitCredentials(params.cwd);
  const tracking = remoteTrackingRef(branch);
  authenticatedGit(params.cwd, params.ctx, "fetch", [
    "--no-tags",
    "+" + "refs/heads/" + branch + ":" + tracking,
  ]);
  return git(params.cwd, ["rev-parse", tracking]).trim().toLowerCase();
}

function assertPrSourceWriteAllowed(
  ctx: AzureDevOpsGitContext,
  permission: AzureDevOpsPushPermission
): void {
  if (permission === "disabled") {
    throw new Error("Azure DevOps push is disabled for this run");
  }

  const source = validateAzureDevOpsBranchName(ctx.sourceBranch);
  const target = validateAzureDevOpsBranchName(ctx.targetBranch);
  if (source === target) {
    throw new Error(
      "Azure DevOps write blocked: PR source branch is the same as the target branch"
    );
  }

  // This slice is deliberately PR-source scoped. "enabled" is accepted so the
  // same permission vocabulary can be carried forward, but it does not turn a
  // validation job into an arbitrary branch writer.
  if (permission !== "restricted" && permission !== "enabled") {
    throw new Error("Azure DevOps PR-source writes require restricted or enabled push access");
  }
}

export function prepareAzureDevOpsSourceCheckout(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  permission: AzureDevOpsPushPermission;
}): { branch: string; sha: string } {
  assertPrSourceWriteAllowed(params.ctx, params.permission);
  scrubAzureDevOpsGitCredentials(params.cwd);

  const dirty = git(params.cwd, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error(
      "Azure DevOps source checkout blocked: working tree is dirty before checkout\n\n" + dirty
    );
  }

  const branch = validateAzureDevOpsBranchName(params.ctx.sourceBranch);
  const expected = params.ctx.sourceCommitId.toLowerCase();
  const remote = fetchAzureDevOpsBranch({
    cwd: params.cwd,
    ctx: params.ctx,
    branch,
  });
  if (remote !== expected) {
    throw new Error(
      "Azure DevOps source checkout blocked: remote source advanced from " +
        expected.slice(0, 12) +
        " to " +
        remote.slice(0, 12)
    );
  }

  git(params.cwd, ["checkout", "-B", branch, expected]);
  git(params.cwd, ["config", "--local", "branch." + branch + ".remote", "origin"]);
  git(params.cwd, [
    "config",
    "--local",
    "branch." + branch + ".merge",
    "refs/heads/" + branch,
  ]);

  return { branch, sha: expected };
}

function assertNoInProgressGitOperation(cwd: string): void {
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const result = spawnSync("git", ["rev-parse", "-q", "--verify", ref], {
      cwd,
      encoding: "utf-8",
      env: credentialFreeEnv(),
    });
    if (result.status === 0) {
      throw new Error(
        "Azure DevOps commit blocked: git operation is already in progress (" + ref + ")"
      );
    }
  }
}

function splitNullList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function changedFiles(cwd: string): string[] {
  const tracked = splitNullList(git(cwd, ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = splitNullList(
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
  );
  return [...new Set([...tracked, ...untracked])].sort();
}

function assertNoChangedLfsFiles(cwd: string, files: string[]): void {
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    const attributes = git(cwd, ["check-attr", "filter", "--", ...batch]);
    const lfs = attributes
      .split("\n")
      .filter((line) => line.trim().endsWith(": filter: lfs"));
    if (lfs.length > 0) {
      throw new Error(
        "Azure DevOps write blocked: changed Git-LFS files require the LFS pre-push hook, " +
          "which is intentionally disabled while Pullfrog holds repository credentials. " +
          "LFS writes are not supported by this safe-write slice.\n\n" +
          lfs.join("\n")
      );
    }
  }
}

export async function commitAndPushAzureDevOpsSource(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  permission: AzureDevOpsPushPermission;
  message: string;
  getLiveSourceCommitId: () => Promise<string | undefined>;
  dryRun?: boolean | undefined;
}): Promise<AzureDevOpsWriteResult> {
  assertPrSourceWriteAllowed(params.ctx, params.permission);
  scrubAzureDevOpsGitCredentials(params.cwd);
  assertNoInProgressGitOperation(params.cwd);

  const message = params.message.trim();
  if (!message) throw new Error("Azure DevOps commit message must not be empty");
  if (message.length > 5000) {
    throw new Error("Azure DevOps commit message must be 5000 characters or fewer");
  }

  const branch = validateAzureDevOpsBranchName(params.ctx.sourceBranch);
  const currentBranch = git(params.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (currentBranch !== branch) {
    throw new Error(
      "Azure DevOps commit blocked: current branch is " +
        currentBranch +
        ", expected PR source branch " +
        branch
    );
  }

  const expected = params.ctx.sourceCommitId.toLowerCase();
  const head = git(params.cwd, ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (head !== expected) {
    throw new Error(
      "Azure DevOps commit blocked: local HEAD is " +
        head.slice(0, 12) +
        ", expected validation source " +
        expected.slice(0, 12) +
        ". Pullfrog owns the commit step; do not create local commits before finalization."
    );
  }

  const live = (await params.getLiveSourceCommitId())?.toLowerCase();
  if (live && live !== expected) {
    throw new Error(
      "Azure DevOps commit blocked: PR source advanced from " +
        expected.slice(0, 12) +
        " to " +
        live.slice(0, 12)
    );
  }

  const remote = fetchAzureDevOpsBranch({
    cwd: params.cwd,
    ctx: params.ctx,
    branch,
  });
  if (remote !== expected) {
    throw new Error(
      "Azure DevOps commit blocked: remote source advanced from " +
        expected.slice(0, 12) +
        " to " +
        remote.slice(0, 12)
    );
  }

  const files = changedFiles(params.cwd);
  if (files.length === 0) {
    throw new Error("Azure DevOps commit blocked: working tree has no changes");
  }
  assertNoChangedLfsFiles(params.cwd, files);

  if (params.dryRun) {
    return {
      branch,
      previousSha: expected,
      pushedSha: expected,
      files,
    };
  }

  git(params.cwd, ["add", "-A", "--", ":/"]);

  const isolated = mkdtempSync(join(tmpdir(), "pullfrog-azdo-commit-"));
  try {
    const commit = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=" + isolated,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Pullfrog",
        "-c",
        "user.email=pullfrog@users.noreply.github.com",
        "commit",
        "-m",
        message,
      ],
      {
        cwd: params.cwd,
        encoding: "utf-8",
        maxBuffer: 32 * 1024 * 1024,
        env: credentialFreeEnv({
          HOME: isolated,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(isolated, "global.gitconfig"),
        }),
      }
    );
    if (commit.error) throw commit.error;
    if (commit.status !== 0) {
      throw new Error(
        "Azure DevOps git commit failed (exit " +
          commit.status +
          "): " +
          String(commit.stderr || commit.stdout || "").trim()
      );
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }

  const pushedSha = git(params.cwd, ["rev-parse", "HEAD"]).trim().toLowerCase();
  const parent = git(params.cwd, ["rev-parse", "HEAD^"]).trim().toLowerCase();
  if (parent !== expected) {
    throw new Error(
      "Azure DevOps push blocked: generated commit is not a direct child of the validated PR source"
    );
  }

  authenticatedGit(params.cwd, params.ctx, "push", [
    "HEAD:refs/heads/" + branch,
  ]);

  return {
    branch,
    previousSha: expected,
    pushedSha,
    files,
  };
}
