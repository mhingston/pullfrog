import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AzureDevOpsPushPermission = "disabled" | "restricted" | "enabled";

export const AZURE_DEVOPS_PULLFROG_BRANCH_PREFIX = "pullfrog/branches/";

export interface AzureDevOpsGitContext {
  collectionUri: string;
  repositoryUri: string;
  defaultBranch: string;
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

type GitFilterCommand = "clean" | "smudge" | "process";

function configuredGitFilterConfigKeys(
  cwd: string,
  commands: readonly GitFilterCommand[]
): string[] {
  const pattern = "^filter\\..*\\.(" + commands.join("|") + ")$";
  const result = spawnSync("git", ["config", "--name-only", "--get-regexp", pattern], {
    cwd,
    encoding: "utf-8",
    env: credentialFreeEnv(),
  });
  if (result.status === 1) return [];
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "failed to inspect Git filter configuration: " +
        String(result.stderr || result.stdout || "").trim()
    );
  }
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function configuredGitFilterDrivers(
  cwd: string,
  commands: readonly GitFilterCommand[]
): Set<string> {
  const drivers = new Set<string>();
  for (const key of configuredGitFilterConfigKeys(cwd, commands)) {
    const match = key.match(/^filter\.(.+)\.(clean|smudge|process)$/i);
    if (match && commands.includes(match[2]!.toLowerCase() as GitFilterCommand)) {
      drivers.add(match[1]!.toLowerCase());
    }
  }
  return drivers;
}

function assertNoConfiguredGitFiltersForFiles(params: {
  cwd: string;
  files: string[];
  commands: readonly GitFilterCommand[];
  operation: string;
  cachedAttributes?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): void {
  const configuredDrivers = configuredGitFilterDrivers(params.cwd, params.commands);
  if (configuredDrivers.size === 0 || params.files.length === 0) return;

  const matches: string[] = [];
  for (let i = 0; i < params.files.length; i += 100) {
    const batch = params.files.slice(i, i + 100);
    const attributes = git(
      params.cwd,
      [
        "check-attr",
        ...(params.cachedAttributes ? ["--cached"] : []),
        "-z",
        "filter",
        "--",
        ...batch,
      ],
      params.env ? { env: params.env } : undefined
    );
    const fields = splitNullList(attributes);
    for (let field = 0; field + 2 < fields.length; field += 3) {
      const path = fields[field]!;
      const attribute = fields[field + 1]!;
      const driver = fields[field + 2]!.toLowerCase();
      if (attribute === "filter" && configuredDrivers.has(driver)) {
        matches.push(path + " (filter=" + driver + ")");
      }
    }
  }

  if (matches.length > 0) {
    throw new Error(
      "Azure DevOps " +
        params.operation +
        " blocked: file(s) select configured Git filter(s):\n" +
        matches.join("\n")
    );
  }
}

function assertNoConfiguredGitFiltersInTree(params: {
  cwd: string;
  treeish: string;
  commands: readonly GitFilterCommand[];
  operation: string;
}): void {
  const isolated = mkdtempSync(join(tmpdir(), "pullfrog-azdo-filter-check-"));
  const env = { GIT_INDEX_FILE: join(isolated, "index") };
  try {
    git(params.cwd, ["read-tree", params.treeish], { env });
    const files = splitNullList(git(params.cwd, ["ls-files", "-z"], { env }));
    assertNoConfiguredGitFiltersForFiles({
      cwd: params.cwd,
      files,
      commands: params.commands,
      operation: params.operation,
      cachedAttributes: true,
      env,
    });
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

export async function withAzureDevOpsIsolatedWorktree<T>(params: {
  cwd: string;
  run: (cwd: string) => Promise<T>;
}): Promise<T> {
  assertNoConfiguredGitFiltersInTree({
    cwd: params.cwd,
    treeish: "HEAD",
    commands: ["smudge", "process"],
    operation: "isolated worktree checkout",
  });
  const root = mkdtempSync(join(tmpdir(), "pullfrog-azdo-worktree-"));
  const worktree = join(root, "checkout");
  let added = false;
  let actionError: unknown;

  try {
    git(params.cwd, ["worktree", "add", "--detach", worktree, "HEAD"]);
    added = true;
    return await params.run(worktree);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (added) {
      try {
        git(params.cwd, ["worktree", "remove", "--force", worktree]);
      } catch (error) {
        cleanupError = error;
      }
      try {
        git(params.cwd, ["worktree", "prune"]);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    rmSync(root, { recursive: true, force: true });
    if (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (actionError) {
        throw new Error(
          (actionError instanceof Error ? actionError.message : String(actionError)) +
            "; additionally failed to clean up isolated Azure worktree: " +
            cleanupMessage,
          { cause: actionError }
        );
      }
      throw new Error("failed to clean up isolated Azure worktree: " + cleanupMessage);
    }
  }
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

export function validateAzureDevOpsPullfrogBranch(branch: string): string {
  const validated = validateAzureDevOpsBranchName(branch);
  if (!validated.startsWith(AZURE_DEVOPS_PULLFROG_BRANCH_PREFIX)) {
    throw new Error(
      "Azure DevOps enabled-mode branch must be under " +
        AZURE_DEVOPS_PULLFROG_BRANCH_PREFIX
    );
  }
  return validated;
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

export function assertAzureDevOpsMergeConfigSafe(cwd: string): void {
  const dangerous = new Set([
    ...localConfigKeys(cwd, "^merge\\..*\\.driver$"),
    ...localConfigKeys(cwd, "^core\\.attributesfile$"),
    ...localConfigKeys(cwd, "^core\\.hookspath$"),
    ...configuredGitFilterConfigKeys(cwd, ["clean", "smudge", "process"]),
  ]);
  if (dangerous.size > 0) {
    throw new Error(
      "Azure DevOps merge repair blocked by executable Git configuration: " +
        [...dangerous].join(", ")
    );
  }
}

function assertNoDangerousAuthenticatedGitConfig(cwd: string): void {
  const dangerous = [
    ...localConfigKeys(cwd, "^include(if)?\\."),
    ...localConfigKeys(cwd, "^url\\..*\\.insteadof$"),
    ...localConfigKeys(cwd, "^http\\."),
    ...localConfigKeys(cwd, "^remote\\..*\\.(uploadpack|receivepack|proxy)$"),
    ...localConfigKeys(cwd, "^core\\.(hookspath|sshcommand|gitproxy|askpass)$"),
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

export function azureDevOpsSourcePushArgs(branch: string, expectedSha: string): string[] {
  const validatedBranch = validateAzureDevOpsBranchName(branch);
  const normalizedExpected = expectedSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedExpected)) {
    throw new Error("invalid Azure DevOps expected source commit for push: " + expectedSha);
  }
  const remoteRef = "refs/heads/" + validatedBranch;
  return [
    "--force-with-lease=" + remoteRef + ":" + normalizedExpected,
    "HEAD:" + remoteRef,
  ];
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
  const defaultBranch = validateAzureDevOpsBranchName(ctx.defaultBranch);
  if (source === target) {
    throw new Error(
      "Azure DevOps write blocked: PR source branch is the same as the target branch"
    );
  }
  if (source === defaultBranch) {
    throw new Error(
      "Azure DevOps write blocked: PR source branch is the repository default branch " +
        defaultBranch
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

  assertNoConfiguredGitFiltersInTree({
    cwd: params.cwd,
    treeish: expected,
    commands: ["smudge", "process"],
    operation: "source checkout",
  });
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

export function prepareAzureDevOpsPullfrogBranchCheckout(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  permission: AzureDevOpsPushPermission;
}): { branch: string; sha: string } {
  if (params.permission !== "enabled") {
    throw new Error(
      "Azure DevOps Pullfrog branch checkout requires enabled push access"
    );
  }
  const branch = validateAzureDevOpsPullfrogBranch(params.ctx.sourceBranch);
  return prepareAzureDevOpsSourceCheckout({
    ...params,
    ctx: {
      ...params.ctx,
      sourceBranch: branch,
    },
  });
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

export interface AzureDevOpsMergePreparation {
  branch: string;
  sourceSha: string;
  targetSha: string;
  conflictedFiles: string[];
}

function inProgressGitRef(cwd: string, ref: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", ref], {
    cwd,
    encoding: "utf-8",
    env: credentialFreeEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return undefined;
  const value = String(result.stdout || "").trim().toLowerCase();
  return value || undefined;
}

function unresolvedMergeFiles(cwd: string): string[] {
  return git(cwd, ["diff", "--name-only", "--diff-filter=U", "--"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function conflictMarkerSize(cwd: string, file: string): number {
  const output = git(cwd, [
    "check-attr",
    "conflict-marker-size",
    "--",
    file,
  ]).trim();
  const value = output.split(": ").at(-1)?.trim();
  if (!value || value === "unspecified") return 7;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      "Azure DevOps merge commit blocked: invalid conflict-marker-size for " +
        file +
        ": " +
        value
    );
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
    throw new Error(
      "Azure DevOps merge commit blocked: invalid conflict-marker-size for " +
        file +
        ": " +
        value
    );
  }
  return parsed;
}

function hasConflictMarkers(
  content: string,
  markerSize: number
): boolean {
  const open = "<".repeat(markerSize);
  const base = "|".repeat(markerSize);
  const split = "=".repeat(markerSize);
  const close = ">".repeat(markerSize);
  return content.split(/\r?\n/).some(
    (line) =>
      line.startsWith(open + " ") ||
      line.startsWith(base + " ") ||
      line.trimEnd() === split ||
      line.startsWith(close + " ")
  );
}


export async function prepareAzureDevOpsMergeResolution(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  permission: AzureDevOpsPushPermission;
  getLiveSourceCommitId: () => Promise<string | undefined>;
  getLiveTargetCommitId: () => Promise<string | undefined>;
}): Promise<AzureDevOpsMergePreparation> {
  assertPrSourceWriteAllowed(params.ctx, params.permission);
  scrubAzureDevOpsGitCredentials(params.cwd);
  assertNoInProgressGitOperation(params.cwd);

  const branch = validateAzureDevOpsBranchName(params.ctx.sourceBranch);
  const targetBranch = validateAzureDevOpsBranchName(params.ctx.targetBranch);
  const sourceSha = params.ctx.sourceCommitId.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("Azure DevOps merge repair requires a valid source SHA");
  }

  const currentBranch = git(params.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const head = git(params.cwd, ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (currentBranch !== branch || head !== sourceSha) {
    throw new Error(
      "Azure DevOps merge repair blocked: checkout is not the validated PR source"
    );
  }

  const liveSource = (await params.getLiveSourceCommitId())?.toLowerCase();
  if (!liveSource || liveSource !== sourceSha) {
    throw new Error(
      "Azure DevOps merge repair blocked: PR source changed before merge preparation"
    );
  }

  const remoteSource = fetchAzureDevOpsBranch({
    cwd: params.cwd,
    ctx: params.ctx,
    branch,
  });
  if (remoteSource !== sourceSha) {
    throw new Error(
      "Azure DevOps merge repair blocked: remote source changed before merge preparation"
    );
  }

  const targetSha = (await params.getLiveTargetCommitId())?.toLowerCase();
  if (!targetSha || !/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error(
      "Azure DevOps merge repair blocked: unable to resolve live target commit"
    );
  }
  const remoteTarget = fetchAzureDevOpsBranch({
    cwd: params.cwd,
    ctx: params.ctx,
    branch: targetBranch,
  });
  if (remoteTarget !== targetSha) {
    throw new Error(
      "Azure DevOps merge repair blocked: target changed while it was fetched"
    );
  }

  assertAzureDevOpsMergeConfigSafe(params.cwd);
  const isolated = mkdtempSync(join(tmpdir(), "pullfrog-azdo-merge-"));
  const hooksDir = join(isolated, "hooks");
  const homeDir = join(isolated, "home");
  mkdirSync(hooksDir);
  mkdirSync(homeDir);

  const merge = (() => {
    try {
      return spawnSync(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "core.hooksPath=" + hooksDir,
          "merge",
          "--no-commit",
          "--no-ff",
          remoteTrackingRef(targetBranch),
        ],
        {
          cwd: params.cwd,
          encoding: "utf-8",
          maxBuffer: 32 * 1024 * 1024,
          env: credentialFreeEnv({
            HOME: homeDir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: join(isolated, "global.gitconfig"),
          }),
        }
      );
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  })();
  if (merge.error) throw merge.error;

  const mergeHead = inProgressGitRef(params.cwd, "MERGE_HEAD");
  if (mergeHead !== targetSha) {
    throw new Error(
      "Azure DevOps merge repair blocked: MERGE_HEAD does not match the validated target"
    );
  }

  const conflictedFiles = unresolvedMergeFiles(params.cwd);
  if (merge.status !== 0 && conflictedFiles.length === 0) {
    throw new Error(
      "Azure DevOps git merge failed without resolvable file conflicts (exit " +
        merge.status +
        "): " +
        String(merge.stderr || merge.stdout || "").trim()
    );
  }

  return { branch, sourceSha, targetSha, conflictedFiles };
}

export function abortAzureDevOpsMergeResolution(cwd: string): void {
  if (!inProgressGitRef(cwd, "MERGE_HEAD")) return;
  const result = spawnSync("git", ["merge", "--abort"], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    env: credentialFreeEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "Azure DevOps merge abort failed: " +
        String(result.stderr || result.stdout || "").trim()
    );
  }
}

export async function commitAndPushAzureDevOpsMergeResolution(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  permission: AzureDevOpsPushPermission;
  message: string;
  targetSha: string;
  conflictedFiles: string[];
  getLiveSourceCommitId: () => Promise<string | undefined>;
  getLiveTargetCommitId: () => Promise<string | undefined>;
  dryRun?: boolean | undefined;
}): Promise<AzureDevOpsWriteResult> {
  assertPrSourceWriteAllowed(params.ctx, params.permission);
  scrubAzureDevOpsGitCredentials(params.cwd);

  for (const ref of ["CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (inProgressGitRef(params.cwd, ref)) {
      throw new Error(
        "Azure DevOps merge commit blocked: unexpected git operation is in progress (" +
          ref +
          ")"
      );
    }
  }

  const branch = validateAzureDevOpsBranchName(params.ctx.sourceBranch);
  const targetBranch = validateAzureDevOpsBranchName(params.ctx.targetBranch);
  const expectedSource = params.ctx.sourceCommitId.toLowerCase();
  const expectedTarget = params.targetSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedTarget)) {
    throw new Error("Azure DevOps merge commit requires a valid target SHA");
  }

  const currentBranch = git(params.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const head = git(params.cwd, ["rev-parse", "HEAD"]).trim().toLowerCase();
  const mergeHead = inProgressGitRef(params.cwd, "MERGE_HEAD");
  if (currentBranch !== branch || head !== expectedSource) {
    throw new Error(
      "Azure DevOps merge commit blocked: checkout moved away from the validated source"
    );
  }
  if (mergeHead !== expectedTarget) {
    throw new Error(
      "Azure DevOps merge commit blocked: MERGE_HEAD changed from the validated target"
    );
  }

  const expectedConflictFiles = [...new Set(params.conflictedFiles)].sort();
  if (expectedConflictFiles.length > 0) {
    for (const file of expectedConflictFiles) {
      const fullPath = join(params.cwd, file);
      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch (error) {
        // A deleted conflict can be a valid resolution. Let git add record the
        // deletion, but fail on other unreadable-file shapes below if they stay
        // unresolved.
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
        continue;
      }
      if (hasConflictMarkers(content, conflictMarkerSize(params.cwd, file))) {
        throw new Error(
          "Azure DevOps merge commit blocked: conflict markers remain in " + file
        );
      }
    }

    assertNoConfiguredGitFiltersForFiles({
      cwd: params.cwd,
      files: expectedConflictFiles,
      commands: ["clean", "process"],
      operation: "merge conflict staging",
    });
    git(params.cwd, ["add", "-A", "--", ...expectedConflictFiles]);
  }

  const unresolved = unresolvedMergeFiles(params.cwd);
  if (unresolved.length > 0) {
    throw new Error(
      "Azure DevOps merge commit blocked: unresolved conflict files remain: " +
        unresolved.join(", ")
    );
  }

  const liveSource = (await params.getLiveSourceCommitId())?.toLowerCase();
  const liveTarget = (await params.getLiveTargetCommitId())?.toLowerCase();
  if (liveSource !== expectedSource) {
    throw new Error(
      "Azure DevOps merge commit blocked: source moved during conflict resolution"
    );
  }
  if (liveTarget !== expectedTarget) {
    throw new Error(
      "Azure DevOps merge commit blocked: target moved during conflict resolution"
    );
  }

  const remoteSource = fetchAzureDevOpsBranch({
    cwd: params.cwd,
    ctx: params.ctx,
    branch,
  });
  const remoteTarget = fetchAzureDevOpsBranch({
    cwd: params.cwd,
    ctx: params.ctx,
    branch: targetBranch,
  });
  if (remoteSource !== expectedSource || remoteTarget !== expectedTarget) {
    throw new Error(
      "Azure DevOps merge commit blocked: remote source/target changed during conflict resolution"
    );
  }

  const message = params.message.trim();
  if (!message) throw new Error("Azure DevOps merge commit message must not be empty");
  if (message.length > 5000) {
    throw new Error("Azure DevOps merge commit message must be 5000 characters or fewer");
  }

  const files = changedFiles(params.cwd);
  if (files.length === 0) {
    throw new Error("Azure DevOps merge commit blocked: merge has no working-tree changes");
  }
  assertNoChangedLfsFiles(params.cwd, files);
  assertNoConfiguredGitFiltersForFiles({
    cwd: params.cwd,
    files,
    commands: ["clean", "process"],
    operation: "merge commit staging",
  });

  if (params.dryRun) {
    return {
      branch,
      previousSha: expectedSource,
      pushedSha: expectedSource,
      files,
    };
  }

  git(params.cwd, ["add", "-A", "--", ":/"]);

  const isolated = mkdtempSync(join(tmpdir(), "pullfrog-azdo-merge-commit-"));
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
        "Azure DevOps merge git commit failed (exit " +
          commit.status +
          "): " +
          String(commit.stderr || commit.stdout || "").trim()
      );
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }

  const pushedSha = git(params.cwd, ["rev-parse", "HEAD"]).trim().toLowerCase();
  const firstParent = git(params.cwd, ["rev-parse", "HEAD^1"]).trim().toLowerCase();
  const secondParent = git(params.cwd, ["rev-parse", "HEAD^2"]).trim().toLowerCase();
  if (firstParent !== expectedSource || secondParent !== expectedTarget) {
    throw new Error(
      "Azure DevOps merge push blocked: generated merge commit parents do not match validated source/target"
    );
  }

  authenticatedGit(
    params.cwd,
    params.ctx,
    "push",
    azureDevOpsSourcePushArgs(branch, expectedSource)
  );

  return {
    branch,
    previousSha: expectedSource,
    pushedSha,
    files,
  };
}

export async function commitAndPushAzureDevOpsPullfrogBranch(params: {
  cwd: string;
  ctx: AzureDevOpsGitContext;
  permission: AzureDevOpsPushPermission;
  message: string;
  getLiveSourceCommitId: () => Promise<string | undefined>;
  verifyOwnership: (branch: string) => Promise<boolean>;
  dryRun?: boolean | undefined;
}): Promise<AzureDevOpsWriteResult> {
  if (params.permission !== "enabled") {
    throw new Error(
      "Azure DevOps Pullfrog branch commit requires enabled push access"
    );
  }
  const branch = validateAzureDevOpsPullfrogBranch(params.ctx.sourceBranch);
  if (!(await params.verifyOwnership(branch))) {
    throw new Error(
      "Azure DevOps Pullfrog branch commit blocked: ownership proof is missing"
    );
  }
  return await commitAndPushAzureDevOpsSource({
    cwd: params.cwd,
    ctx: {
      ...params.ctx,
      sourceBranch: branch,
    },
    permission: params.permission,
    message: params.message,
    getLiveSourceCommitId: params.getLiveSourceCommitId,
    dryRun: params.dryRun,
  });
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

  const files = changedFiles(params.cwd);
  if (files.length === 0) {
    throw new Error("Azure DevOps commit blocked: working tree has no changes");
  }
  assertNoChangedLfsFiles(params.cwd, files);
  assertNoConfiguredGitFiltersForFiles({
    cwd: params.cwd,
    files,
    commands: ["clean", "process"],
    operation: "commit staging",
  });

  const live = (await params.getLiveSourceCommitId())?.toLowerCase();
  if (!live) {
    throw new Error(
      "Azure DevOps commit blocked: unable to verify the live PR source commit"
    );
  }
  if (live !== expected) {
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

  // Use an explicit lease as a compare-and-swap guard. The commit-parent
  // check above proves this is a fast-forward from `expected`; the lease adds
  // the stronger requirement that the remote ref is STILL exactly `expected`
  // at the instant the server accepts the update (including force-reset races).
  authenticatedGit(
    params.cwd,
    params.ctx,
    "push",
    azureDevOpsSourcePushArgs(branch, expected)
  );

  return {
    branch,
    previousSha: expected,
    pushedSha,
    files,
  };
}
