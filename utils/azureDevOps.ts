import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type AzureDevOpsPushPermission,
  validateAzureDevOpsBranchName,
} from "./azureDevOpsGit.ts";

export const AZDO_REVIEW_MARKER_PREFIX = "<!-- pullfrog-azure-devops-review:";
export const AZDO_FINDING_MARKER_PREFIX = "<!-- pullfrog-azure-devops-finding:";
export const AZDO_FOLLOWUP_MARKER_PREFIX = "<!-- pullfrog-azure-devops-followup:";
export const AZDO_STATUS_GENRE = "pullfrog";
export const AZDO_STATUS_NAME = "review";

export function azureDevOpsReviewMarker(sourceCommitId: string): string {
  return AZDO_REVIEW_MARKER_PREFIX + sourceCommitId.toLowerCase() + " -->";
}

function findingFingerprint(path: string, line: number): string {
  return createHash("sha256")
    .update(path.replace(/^\/+/, "") + ":" + line)
    .digest("hex")
    .slice(0, 16);
}

export function azureDevOpsFindingMarker(
  sourceCommitId: string,
  path: string,
  line: number
): string {
  return (
    AZDO_FINDING_MARKER_PREFIX +
    sourceCommitId.toLowerCase() +
    ":" +
    findingFingerprint(path, line) +
    " -->"
  );
}

export interface AzureDevOpsRepositoryContext {
  collectionUri: string;
  project: string;
  repositoryId: string;
  repositoryUri: string;
  defaultBranch: string;
  authorization: string;
}

export interface AzureDevOpsContext extends AzureDevOpsRepositoryContext {
  pullRequestId: number;
  sourceBranch: string;
  sourceCommitId: string;
  targetBranch: string;
}

export type AzureDevOpsClientContext = AzureDevOpsRepositoryContext & {
  pullRequestId: number;
};

export interface AzureDevOpsPullRequest {
  pullRequestId: number;
  title: string;
  description?: string | null;
  sourceRefName: string;
  targetRefName: string;
  repository?: { id?: string | undefined } | undefined;
  createdBy?: { displayName?: string | undefined } | undefined;
  lastMergeSourceCommit?: { commitId?: string | undefined } | undefined;
  url?: string | undefined;
}

interface AzureDevOpsGitRef {
  name: string;
  objectId?: string | undefined;
}

export interface AzureDevOpsIdentity {
  id?: string | undefined;
  displayName?: string | undefined;
  uniqueName?: string | undefined;
}

export interface AzureDevOpsComment {
  id: number;
  parentCommentId?: number | undefined;
  content?: string | null;
  isDeleted?: boolean | undefined;
  commentType?: number | string | undefined;
  author?: AzureDevOpsIdentity | undefined;
  publishedDate?: string | undefined;
}

export interface AzureDevOpsThread {
  id: number;
  comments?: AzureDevOpsComment[] | undefined;
  isDeleted?: boolean | undefined;
  status?: number | string | undefined;
}

interface AzureDevOpsIteration {
  id: number;
  sourceRefCommit?: { commitId?: string | undefined } | undefined;
}

interface AzureDevOpsIterationChange {
  changeTrackingId: number;
  item?: { path?: string | undefined } | undefined;
}

interface AzureDevOpsIterationChanges {
  changeEntries?: AzureDevOpsIterationChange[] | undefined;
  nextSkip?: number | undefined;
  nextTop?: number | undefined;
}

interface AzureDevOpsStatus {
  id: number;
  state?: string | undefined;
}

export type AzureDevOpsStatusState = "pending" | "succeeded" | "failed" | "error";

export interface AzureDevOpsInlineFinding {
  path: string;
  line: number;
  body: string;
}

export type AzureDevOpsStatusPublication =
  | { published: true; statusId: number; iterationId: number }
  | { published: false; supersededBy: string };

export type AzureDevOpsInlinePublication =
  | {
      published: true;
      iterationId: number;
      threadIds: number[];
      skipped: Array<{ path: string; line: number; reason: string }>;
    }
  | { published: false; supersededBy: string };

export type AzureDevOpsReviewPublication =
  | { published: true; created: boolean; threadId: number }
  | { published: false; supersededBy: string };

interface AzureDevOpsList<T> {
  value: T[];
}

interface AzureDevOpsRefUpdateResult {
  name: string;
  oldObjectId?: string | undefined;
  newObjectId?: string | undefined;
  updateStatus?: string | undefined;
  success?: boolean | undefined;
  customMessage?: string | undefined;
}

type AzureDevOpsRefUpdateResponse =
  | AzureDevOpsRefUpdateResult[]
  | {
      value?: AzureDevOpsRefUpdateResult[] | undefined;
      count?: number | undefined;
    };

export interface AzureDevOpsFollowUpLock {
  refName: string;
  sourceCommitId: string;
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error("Azure DevOps context is missing " + name);
  return trimmed;
}

function positiveInteger(name: string, value: string | undefined): number {
  const parsed = Number(required(name, value));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Azure DevOps context has invalid " + name + ": " + value);
  }
  return parsed;
}

export function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function buildAzureDevOpsAuthorization(env: NodeJS.ProcessEnv): string {
  const systemToken = env.SYSTEM_ACCESSTOKEN?.trim() || env.AZURE_DEVOPS_TOKEN?.trim();
  if (systemToken) return "Bearer " + systemToken;

  const pat = env.AZURE_DEVOPS_PAT?.trim();
  if (pat) return "Basic " + Buffer.from(":" + pat).toString("base64");

  throw new Error(
    "Azure DevOps authentication is missing. Map $(System.AccessToken) to SYSTEM_ACCESSTOKEN, " +
      "or set AZURE_DEVOPS_PAT."
  );
}

export function resolveAzureDevOpsRepositoryContext(
  env: NodeJS.ProcessEnv = process.env
): AzureDevOpsRepositoryContext {
  const collectionUri = required(
    "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI",
    env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || env.SYSTEM_COLLECTIONURI
  ).replace(/\/*$/, "/");
  const project = required("SYSTEM_TEAMPROJECT", env.SYSTEM_TEAMPROJECT);
  const repositoryId = required("BUILD_REPOSITORY_ID", env.BUILD_REPOSITORY_ID);
  const repositoryUri = required("BUILD_REPOSITORY_URI", env.BUILD_REPOSITORY_URI);
  const defaultBranch = stripRefsHeads(
    required("BUILD_REPOSITORY_DEFAULTBRANCH", env.BUILD_REPOSITORY_DEFAULTBRANCH)
  );
  const repositoryProvider = env.BUILD_REPOSITORY_PROVIDER?.trim();
  if (repositoryProvider && repositoryProvider !== "TfsGit") {
    throw new Error(
      "pullfrog azdo currently supports Azure Repos Git only; BUILD_REPOSITORY_PROVIDER=" +
        repositoryProvider
    );
  }
  return {
    collectionUri,
    project,
    repositoryId,
    repositoryUri,
    defaultBranch,
    authorization: buildAzureDevOpsAuthorization(env),
  };
}

export function resolveAzureDevOpsContext(
  env: NodeJS.ProcessEnv = process.env
): AzureDevOpsContext {
  const repository = resolveAzureDevOpsRepositoryContext(env);
  const pullRequestId = positiveInteger(
    "SYSTEM_PULLREQUEST_PULLREQUESTID",
    env.SYSTEM_PULLREQUEST_PULLREQUESTID
  );
  const sourceBranch = stripRefsHeads(
    required("SYSTEM_PULLREQUEST_SOURCEBRANCH", env.SYSTEM_PULLREQUEST_SOURCEBRANCH)
  );
  const sourceCommitId = required(
    "SYSTEM_PULLREQUEST_SOURCECOMMITID",
    env.SYSTEM_PULLREQUEST_SOURCECOMMITID
  );
  if (!/^[0-9a-f]{40}$/i.test(sourceCommitId)) {
    throw new Error(
      "Azure DevOps context has invalid SYSTEM_PULLREQUEST_SOURCECOMMITID: " + sourceCommitId
    );
  }
  const targetBranch = stripRefsHeads(
    required("SYSTEM_PULLREQUEST_TARGETBRANCH", env.SYSTEM_PULLREQUEST_TARGETBRANCH)
  );

  return {
    ...repository,
    pullRequestId,
    sourceBranch,
    sourceCommitId,
    targetBranch,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}

function ensureRemoteRef(params: { cwd: string; branch: string }): string {
  const remoteRef = "refs/remotes/origin/" + params.branch;
  try {
    git(params.cwd, [
      "fetch",
      "--no-tags",
      "origin",
      "+" + "refs/heads/" + params.branch + ":" + remoteRef,
    ]);
    return remoteRef;
  } catch (error) {
    try {
      git(params.cwd, ["rev-parse", "--verify", "--quiet", remoteRef]);
      return remoteRef;
    } catch {
      throw new Error(
        "cannot fetch Azure DevOps branch " +
          params.branch +
          ". Use checkout: self with fetchDepth: 0 and persistCredentials: true. Original error: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }
}

function ensureSourceCommit(params: {
  cwd: string;
  sourceBranch: string;
  sourceCommitId: string;
}): void {
  try {
    git(params.cwd, ["cat-file", "-e", params.sourceCommitId + "^{commit}"]);
  } catch {
    const remoteRef = ensureRemoteRef({ cwd: params.cwd, branch: params.sourceBranch });
    try {
      git(params.cwd, ["cat-file", "-e", params.sourceCommitId + "^{commit}"]);
    } catch {
      throw new Error(
        "Azure DevOps source commit " +
          params.sourceCommitId +
          " is not available after fetching " +
          remoteRef
      );
    }
  }
}

export function buildAzureDevOpsPullRequestDiff(params: {
  cwd: string;
  sourceBranch: string;
  sourceCommitId: string;
  targetBranch: string;
  maxChars?: number | undefined;
}): { diff: string; mergeBase: string; truncated: boolean } {
  const targetRef = ensureRemoteRef({ cwd: params.cwd, branch: params.targetBranch });
  ensureSourceCommit({
    cwd: params.cwd,
    sourceBranch: params.sourceBranch,
    sourceCommitId: params.sourceCommitId,
  });

  const mergeBase = git(params.cwd, ["merge-base", params.sourceCommitId, targetRef]).trim();
  const raw = git(params.cwd, [
    "diff",
    "--find-renames",
    "--no-ext-diff",
    "--unified=60",
    mergeBase + ".." + params.sourceCommitId,
    "--",
  ]);

  if (!raw.trim()) {
    throw new Error(
      "Azure DevOps PR diff is empty against " +
        params.targetBranch +
        " (merge base " +
        mergeBase +
        ")"
    );
  }

  const maxChars = params.maxChars ?? 250_000;
  if (raw.length <= maxChars) {
    return { diff: raw, mergeBase, truncated: false };
  }

  return {
    diff:
      raw.slice(0, maxChars) +
      "\n\n[Pullfrog truncated this diff for model context; review the repository for omitted details.]",
    mergeBase,
    truncated: true,
  };
}

export class AzureDevOpsRepositoryClient {
  readonly #ctx: AzureDevOpsRepositoryContext;

  constructor(ctx: AzureDevOpsRepositoryContext) {
    this.#ctx = ctx;
  }

  #url(path: string): string {
    const project = encodeURIComponent(this.#ctx.project);
    const repo = encodeURIComponent(this.#ctx.repositoryId);
    return new URL(
      project + "/_apis/git/repositories/" + repo + path,
      this.#ctx.collectionUri
    ).toString();
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", this.#ctx.authorization);
    if (init?.body) headers.set("Content-Type", "application/json");

    const response = await fetch(this.#url(path), {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(
        "Azure DevOps API failed: " +
          response.status +
          " " +
          response.statusText +
          (body ? " -- " + body : "")
      );
    }
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async getBranchObjectId(branch: string): Promise<string | undefined> {
    const validated = validateAzureDevOpsBranchName(branch);
    const fullRef = "refs/heads/" + validated;
    const response = await this.#request<AzureDevOpsList<AzureDevOpsGitRef>>(
      "/refs?filter=" +
        encodeURIComponent("heads/" + validated) +
        "&$top=2&api-version=7.1"
    );
    const exact = response.value.find((ref) => ref.name === fullRef);
    return exact?.objectId?.toLowerCase();
  }

  async createPullRequestFromPullfrogBranch(params: {
    sourceBranch: string;
    sourceCommitId: string;
    targetBranch: string;
    title: string;
    description: string;
    permission: AzureDevOpsPushPermission;
  }): Promise<AzureDevOpsPullRequest> {
    if (params.permission !== "enabled") {
      throw new Error(
        "Azure DevOps PR creation requires enabled push permission"
      );
    }

    const sourceBranch = validateAzureDevOpsBranchName(params.sourceBranch);
    const targetBranch = validateAzureDevOpsBranchName(params.targetBranch);
    if (!sourceBranch.startsWith("pullfrog/branches/")) {
      throw new Error(
        "Azure DevOps PR creation requires a Pullfrog-owned source branch under pullfrog/branches/"
      );
    }
    if (sourceBranch === targetBranch) {
      throw new Error(
        "Azure DevOps PR creation blocked: source and target branches are identical"
      );
    }
    if (targetBranch.startsWith("pullfrog/locks/")) {
      throw new Error(
        "Azure DevOps PR creation blocked: lock refs cannot be PR targets"
      );
    }

    const sourceCommitId = params.sourceCommitId.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sourceCommitId)) {
      throw new Error(
        "Azure DevOps PR creation requires a valid expected source commit"
      );
    }

    const title = params.title.trim();
    if (!title) {
      throw new Error("Azure DevOps PR title must not be empty");
    }
    if (params.description.length > 4000) {
      throw new Error(
        "Azure DevOps PR description must be 4000 characters or fewer"
      );
    }

    const liveSource = await this.getBranchObjectId(sourceBranch);
    if (!liveSource) {
      throw new Error(
        "Azure DevOps PR creation blocked: source branch does not exist: " +
          sourceBranch
      );
    }
    if (liveSource !== sourceCommitId) {
      throw new Error(
        "Azure DevOps PR creation blocked: source branch advanced from " +
          sourceCommitId.slice(0, 12) +
          " to " +
          liveSource.slice(0, 12)
      );
    }

    const liveTarget = await this.getBranchObjectId(targetBranch);
    if (!liveTarget) {
      throw new Error(
        "Azure DevOps PR creation blocked: target branch does not exist: " +
          targetBranch
      );
    }

    const created = await this.#request<AzureDevOpsPullRequest>(
      "/pullrequests?api-version=7.1",
      {
        method: "POST",
        body: JSON.stringify({
          sourceRefName: "refs/heads/" + sourceBranch,
          targetRefName: "refs/heads/" + targetBranch,
          title,
          description: params.description,
        }),
      }
    );

    if (!Number.isInteger(created.pullRequestId) || created.pullRequestId <= 0) {
      throw new Error("Azure DevOps PR creation returned an invalid pull request id");
    }
    if (
      created.repository?.id &&
      created.repository.id.toLowerCase() !== this.#ctx.repositoryId.toLowerCase()
    ) {
      throw new Error(
        "Azure DevOps PR creation returned an unexpected repository id"
      );
    }
    if (
      created.sourceRefName !== "refs/heads/" + sourceBranch ||
      created.targetRefName !== "refs/heads/" + targetBranch
    ) {
      throw new Error(
        "Azure DevOps PR creation returned unexpected source/target refs"
      );
    }

    const liveAfter = await this.getBranchObjectId(sourceBranch);
    if (!liveAfter || liveAfter !== sourceCommitId) {
      await this.#request<AzureDevOpsPullRequest>(
        "/pullrequests/" + created.pullRequestId + "?api-version=7.1",
        {
          method: "PATCH",
          body: JSON.stringify({ status: "abandoned" }),
        }
      );
      throw new Error(
        "Azure DevOps PR creation raced with source movement; created PR #" +
          created.pullRequestId +
          " was abandoned"
      );
    }

    return created;
  }

  async listActivePullRequests(params?: {
    max?: number | undefined;
  }): Promise<AzureDevOpsPullRequest[]> {
    const max = params?.max ?? 200;
    if (!Number.isInteger(max) || max <= 0 || max > 1000) {
      throw new Error("Azure DevOps active PR max must be between 1 and 1000");
    }

    const results: AzureDevOpsPullRequest[] = [];
    const pageSize = Math.min(100, max);

    for (let skip = 0; results.length < max; skip += pageSize) {
      const remaining = max - results.length;
      const top = Math.min(pageSize, remaining);
      const response = await this.#request<AzureDevOpsList<AzureDevOpsPullRequest>>(
        "/pullrequests?searchCriteria.status=active&$skip=" +
          skip +
          "&$top=" +
          top +
          "&api-version=7.1"
      );
      results.push(...response.value);
      if (response.value.length < top) break;
    }

    return results.slice(0, max);
  }

  followUpLockRef(params: {
    pullRequestId: number;
    threadId: number;
    triggerCommentId: number;
  }): string {
    for (const [name, value] of [
      ["pull request id", params.pullRequestId],
      ["thread id", params.threadId],
      ["trigger comment id", params.triggerCommentId],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("Azure DevOps follow-up lock has invalid " + name);
      }
    }
    return (
      "refs/heads/pullfrog/locks/follow-up/pr-" +
      params.pullRequestId +
      "-thread-" +
      params.threadId +
      "-comment-" +
      params.triggerCommentId
    );
  }

  async acquireFollowUpLock(params: {
    pullRequestId: number;
    threadId: number;
    triggerCommentId: number;
    sourceCommitId: string;
  }): Promise<
    | { acquired: true; lock: AzureDevOpsFollowUpLock }
    | { acquired: false; reason: "claimed"; refName: string }
  > {
    const sourceCommitId = params.sourceCommitId.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sourceCommitId)) {
      throw new Error("Azure DevOps follow-up lock requires a valid source commit");
    }

    const refName = this.followUpLockRef(params);
    const zeros = "0".repeat(40);
    const response = await this.#request<AzureDevOpsRefUpdateResponse>(
      "/refs?api-version=7.1",
      {
        method: "POST",
        body: JSON.stringify([
          {
            name: refName,
            oldObjectId: zeros,
            newObjectId: sourceCommitId,
          },
        ]),
      }
    );
    const result = Array.isArray(response) ? response[0] : response.value?.[0];
    if (!result) {
      throw new Error("Azure DevOps follow-up lock update returned no result");
    }

    if (result.success === true || result.updateStatus === "succeeded") {
      return {
        acquired: true,
        lock: { refName, sourceCommitId },
      };
    }

    if (result.updateStatus === "staleOldObjectId") {
      return { acquired: false, reason: "claimed", refName };
    }

    throw new Error(
      "Azure DevOps follow-up lock acquisition failed: " +
        (result.updateStatus ?? "unknown") +
        (result.customMessage ? " -- " + result.customMessage : "")
    );
  }

  async releaseFollowUpLock(lock: AzureDevOpsFollowUpLock): Promise<void> {
    if (!/^refs\/heads\/pullfrog\/locks\/follow-up\//.test(lock.refName)) {
      throw new Error("refusing to release an unexpected Azure DevOps ref");
    }
    if (!/^[0-9a-f]{40}$/.test(lock.sourceCommitId)) {
      throw new Error("Azure DevOps follow-up lock has invalid source commit");
    }

    const zeros = "0".repeat(40);
    const response = await this.#request<AzureDevOpsRefUpdateResponse>(
      "/refs?api-version=7.1",
      {
        method: "POST",
        body: JSON.stringify([
          {
            name: lock.refName,
            oldObjectId: lock.sourceCommitId,
            newObjectId: zeros,
          },
        ]),
      }
    );
    const result = Array.isArray(response) ? response[0] : response.value?.[0];
    if (!result) {
      throw new Error("Azure DevOps follow-up lock release returned no result");
    }
    if (
      result.success === true ||
      result.updateStatus === "succeeded" ||
      result.updateStatus === "succeededNonExistentRef"
    ) {
      return;
    }

    throw new Error(
      "Azure DevOps follow-up lock release failed: " +
        (result.updateStatus ?? "unknown") +
        (result.customMessage ? " -- " + result.customMessage : "")
    );
  }
}

export class AzureDevOpsClient {
  readonly #ctx: AzureDevOpsClientContext;

  constructor(ctx: AzureDevOpsClientContext) {
    this.#ctx = ctx;
  }

  #url(path: string): string {
    const project = encodeURIComponent(this.#ctx.project);
    const repo = encodeURIComponent(this.#ctx.repositoryId);
    const pr = this.#ctx.pullRequestId;
    return new URL(
      project + "/_apis/git/repositories/" + repo + "/pullRequests/" + pr + path,
      this.#ctx.collectionUri
    ).toString();
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", this.#ctx.authorization);
    if (init?.body) headers.set("Content-Type", "application/json");

    const response = await fetch(this.#url(path), {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(
        "Azure DevOps API failed: " +
          response.status +
          " " +
          response.statusText +
          (body ? " -- " + body : "")
      );
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async getPullRequest(): Promise<AzureDevOpsPullRequest> {
    return await this.#request<AzureDevOpsPullRequest>("?api-version=7.1");
  }

  async updatePullRequestDescription(
    description: string,
    expectedSourceCommitId?: string
  ): Promise<AzureDevOpsPullRequest> {
    if (description.length > 4000) {
      throw new Error(
        "Azure DevOps PR description must be 4000 characters or fewer"
      );
    }

    if (expectedSourceCommitId !== undefined) {
      const expected = expectedSourceCommitId.trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(expected)) {
        throw new Error(
          "Azure DevOps PR mutation requires a valid expected source commit"
        );
      }
      const live = await this.getLiveSourceCommitId();
      if (!live) {
        throw new Error(
          "Azure DevOps PR mutation blocked: unable to verify live source commit"
        );
      }
      if (live !== expected) {
        throw new Error(
          "Azure DevOps PR mutation blocked: source advanced from " +
            expected.slice(0, 12) +
            " to " +
            live.slice(0, 12)
        );
      }
    }

    return await this.#request<AzureDevOpsPullRequest>("?api-version=7.1", {
      method: "PATCH",
      body: JSON.stringify({ description }),
    });
  }

  async getThread(threadId: number): Promise<AzureDevOpsThread> {
    if (!Number.isInteger(threadId) || threadId <= 0) {
      throw new Error("Azure DevOps thread id must be a positive integer");
    }
    return await this.#request<AzureDevOpsThread>(
      "/threads/" + threadId + "?api-version=7.1"
    );
  }

  #followUpMarker(threadId: number, triggerCommentId: number): string {
    return (
      AZDO_FOLLOWUP_MARKER_PREFIX +
      threadId +
      ":" +
      triggerCommentId +
      " -->"
    );
  }

  #followUpComments(
    thread: AzureDevOpsThread,
    marker: string
  ): AzureDevOpsComment[] {
    return (thread.comments ?? [])
      .filter(
        (comment) =>
          !comment.isDeleted &&
          typeof comment.content === "string" &&
          comment.content.includes(marker)
      )
      .sort((a, b) => a.id - b.id);
  }

  async #deleteDuplicateFollowUpComments(
    threadId: number,
    comments: AzureDevOpsComment[]
  ): Promise<void> {
    for (const duplicate of comments.slice(1)) {
      try {
        await this.#request<void>(
          "/threads/" +
            threadId +
            "/comments/" +
            duplicate.id +
            "?api-version=7.1",
          { method: "DELETE" }
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/^Azure DevOps API failed: 404\b/.test(error.message)
        ) {
          throw error;
        }
      }
    }
  }

  async reconcileThreadFollowUp(params: {
    threadId: number;
    triggerCommentId: number;
    resolve?: boolean | undefined;
  }): Promise<{ commentId: number } | undefined> {
    if (!Number.isInteger(params.triggerCommentId) || params.triggerCommentId <= 0) {
      throw new Error("Azure DevOps trigger comment id must be a positive integer");
    }

    const thread = await this.getThread(params.threadId);
    const trigger = (thread.comments ?? []).find(
      (comment) => comment.id === params.triggerCommentId && !comment.isDeleted
    );
    if (!trigger) {
      throw new Error(
        "Azure DevOps trigger comment " +
          params.triggerCommentId +
          " does not exist in thread " +
          params.threadId
      );
    }

    const marker = this.#followUpMarker(
      params.threadId,
      params.triggerCommentId
    );
    const existing = this.#followUpComments(thread, marker);
    const canonical = existing[0];
    if (!canonical) return undefined;

    // Retry is a convergence path too: if an earlier overlapping run crashed
    // after POST, clean up any marker-bearing duplicates before returning.
    await this.#deleteDuplicateFollowUpComments(params.threadId, existing);
    if (params.resolve) await this.#setThreadStatus(params.threadId, 4);

    return { commentId: canonical.id };
  }

  async replyToThreadFollowUp(params: {
    threadId: number;
    triggerCommentId: number;
    markdown: string;
    resolve?: boolean | undefined;
  }): Promise<{ created: boolean; commentId: number }> {
    const markdown = params.markdown.trim();
    if (!markdown) {
      throw new Error("Azure DevOps follow-up reply must not be empty");
    }
    if (/<!--\s*pullfrog-azure-devops-/i.test(markdown)) {
      throw new Error(
        "Azure DevOps follow-up reply contains reserved Pullfrog marker syntax"
      );
    }

    const reconciled = await this.reconcileThreadFollowUp({
      threadId: params.threadId,
      triggerCommentId: params.triggerCommentId,
      resolve: params.resolve,
    });
    if (reconciled) {
      return { created: false, commentId: reconciled.commentId };
    }

    const marker = this.#followUpMarker(
      params.threadId,
      params.triggerCommentId
    );
    const posted = await this.#request<AzureDevOpsComment>(
      "/threads/" + params.threadId + "/comments?api-version=7.1",
      {
        method: "POST",
        body: JSON.stringify({
          parentCommentId: params.triggerCommentId,
          content: markdown + "\n\n" + marker,
          commentType: 1,
        }),
      }
    );

    // POST is not conditional. Converge overlapping retries by keeping the
    // lowest marker-bearing comment ID and deleting later duplicates.
    const after = await this.getThread(params.threadId);
    const matching = this.#followUpComments(after, marker);
    const canonical = matching[0] ?? posted;
    await this.#deleteDuplicateFollowUpComments(params.threadId, matching);

    if (params.resolve) await this.#setThreadStatus(params.threadId, 4);
    return { created: canonical.id === posted.id, commentId: canonical.id };
  }

  async #listIterations(): Promise<AzureDevOpsIteration[]> {
    const response = await this.#request<AzureDevOpsList<AzureDevOpsIteration>>(
      "/iterations?api-version=7.1"
    );
    return response.value;
  }

  async #iterationForSource(sourceCommitId: string): Promise<AzureDevOpsIteration | undefined> {
    const normalized = sourceCommitId.toLowerCase();
    const iterations = await this.#listIterations();
    return [...iterations]
      .reverse()
      .find(
        (iteration) =>
          iteration.sourceRefCommit?.commitId?.toLowerCase() === normalized
      );
  }

  async #iterationChanges(iterationId: number): Promise<AzureDevOpsIterationChange[]> {
    const changes: AzureDevOpsIterationChange[] = [];
    let skip = 0;
    let top = 2000;

    for (let page = 0; page < 50; page += 1) {
      const response = await this.#request<AzureDevOpsIterationChanges>(
        "/iterations/" +
          iterationId +
          "/changes?$top=" +
          top +
          "&$skip=" +
          skip +
          "&api-version=7.1"
      );
      changes.push(...(response.changeEntries ?? []));

      const nextSkip = response.nextSkip ?? 0;
      const nextTop = response.nextTop ?? 0;
      if (nextSkip <= 0 || nextTop <= 0) break;
      skip = nextSkip;
      top = Math.min(nextTop, 2000);
    }

    return changes;
  }

  async #publicationIteration(
    sourceCommitId: string
  ): Promise<{ iterationId: number } | { supersededBy: string }> {
    const normalized = sourceCommitId.toLowerCase();
    const live = await this.getLiveSourceCommitId();
    if (live && live !== normalized) return { supersededBy: live };

    const iteration = await this.#iterationForSource(normalized);
    if (!iteration) {
      throw new Error(
        "cannot find Azure DevOps PR iteration for source commit " + sourceCommitId
      );
    }
    return { iterationId: iteration.id };
  }

  async publishReviewStatus(params: {
    sourceCommitId: string;
    state: AzureDevOpsStatusState;
    description: string;
  }): Promise<AzureDevOpsStatusPublication> {
    const context = await this.#publicationIteration(params.sourceCommitId);
    if ("supersededBy" in context) {
      return { published: false, supersededBy: context.supersededBy };
    }

    const posted = await this.#request<AzureDevOpsStatus>("/statuses?api-version=7.1", {
      method: "POST",
      body: JSON.stringify({
        iterationId: context.iterationId,
        state: params.state,
        description: params.description.slice(0, 256),
        context: {
          genre: AZDO_STATUS_GENRE,
          name: AZDO_STATUS_NAME,
        },
      }),
    });

    // Statuses are iteration-scoped. If the head moved while the write was in
    // flight, the old iteration status cannot represent the new source.
    const liveAfter = await this.getLiveSourceCommitId();
    const normalized = params.sourceCommitId.toLowerCase();
    if (liveAfter && liveAfter !== normalized) {
      return { published: false, supersededBy: liveAfter };
    }

    return {
      published: true,
      statusId: posted.id,
      iterationId: context.iterationId,
    };
  }

  async listThreads(): Promise<AzureDevOpsThread[]> {
    const response = await this.#request<AzureDevOpsList<AzureDevOpsThread>>(
      "/threads?api-version=7.1"
    );
    return response.value.filter((thread) => !thread.isDeleted);
  }

  #reviewMarker(comment: AzureDevOpsComment): string | undefined {
    if (comment.isDeleted || typeof comment.content !== "string") return undefined;
    const match = comment.content.match(
      /<!-- pullfrog-azure-devops-review:([0-9a-f]{40}) -->/i
    );
    return match?.[1]?.toLowerCase();
  }

  #markedThreads(threads: AzureDevOpsThread[]): Array<{
    thread: AzureDevOpsThread;
    comment: AzureDevOpsComment;
    sourceCommitId: string;
  }> {
    const marked: Array<{
      thread: AzureDevOpsThread;
      comment: AzureDevOpsComment;
      sourceCommitId: string;
    }> = [];
    for (const thread of threads) {
      const comment = thread.comments?.find((candidate) => this.#reviewMarker(candidate));
      if (!comment) continue;
      const sourceCommitId = this.#reviewMarker(comment);
      if (!sourceCommitId) continue;
      marked.push({ thread, comment, sourceCommitId });
    }
    return marked.sort((left, right) => left.thread.id - right.thread.id);
  }

  #findingMarker(comment: AzureDevOpsComment):
    | { sourceCommitId: string; fingerprint: string }
    | undefined {
    if (comment.isDeleted || typeof comment.content !== "string") return undefined;
    const match = comment.content.match(
      /<!-- pullfrog-azure-devops-finding:([0-9a-f]{40}):([0-9a-f]{16}) -->/i
    );
    if (!match?.[1] || !match[2]) return undefined;
    return {
      sourceCommitId: match[1].toLowerCase(),
      fingerprint: match[2].toLowerCase(),
    };
  }

  #markedFindingThreads(threads: AzureDevOpsThread[]): Array<{
    thread: AzureDevOpsThread;
    comment: AzureDevOpsComment;
    sourceCommitId: string;
    fingerprint: string;
  }> {
    const marked: Array<{
      thread: AzureDevOpsThread;
      comment: AzureDevOpsComment;
      sourceCommitId: string;
      fingerprint: string;
    }> = [];

    for (const thread of threads) {
      for (const comment of thread.comments ?? []) {
        const marker = this.#findingMarker(comment);
        if (!marker) continue;
        marked.push({ thread, comment, ...marker });
        break;
      }
    }

    return marked.sort((left, right) => left.thread.id - right.thread.id);
  }

  async #updateReviewComment(threadId: number, commentId: number, content: string): Promise<void> {
    await this.#request(
      "/threads/" + threadId + "/comments/" + commentId + "?api-version=7.1",
      {
        method: "PATCH",
        body: JSON.stringify({
          id: commentId,
          content,
          commentType: 1,
        }),
      }
    );
  }

  async #setThreadStatus(threadId: number, status: 1 | 4): Promise<void> {
    await this.#request("/threads/" + threadId + "?api-version=7.1", {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  async getLiveSourceCommitId(): Promise<string | undefined> {
    return (await this.getPullRequest()).lastMergeSourceCommit?.commitId?.toLowerCase();
  }

  async upsertInlineReviewThreads(
    findings: AzureDevOpsInlineFinding[],
    sourceCommitId: string
  ): Promise<AzureDevOpsInlinePublication> {
    const normalizedSourceCommitId = sourceCommitId.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalizedSourceCommitId)) {
      throw new Error(
        "invalid Azure DevOps source commit for inline review publication: " +
          sourceCommitId
      );
    }

    const context = await this.#publicationIteration(normalizedSourceCommitId);
    if ("supersededBy" in context) {
      return { published: false, supersededBy: context.supersededBy };
    }

    const changes = await this.#iterationChanges(context.iterationId);
    const trackingByPath = new Map<string, number>();
    for (const change of changes) {
      const path = change.item?.path?.replace(/^\/+/, "");
      if (path && Number.isInteger(change.changeTrackingId)) {
        trackingByPath.set(path, change.changeTrackingId);
      }
    }

    const before = this.#markedFindingThreads(await this.listThreads());
    const desired = new Map<
      string,
      { finding: AzureDevOpsInlineFinding; content: string; changeTrackingId: number }
    >();
    const skipped: Array<{ path: string; line: number; reason: string }> = [];

    for (const finding of findings) {
      const path = finding.path.replace(/^\/+/, "");
      const changeTrackingId = trackingByPath.get(path);
      if (changeTrackingId === undefined) {
        skipped.push({
          path,
          line: finding.line,
          reason: "file was not found in the cumulative Azure PR iteration changes",
        });
        continue;
      }

      const marker = azureDevOpsFindingMarker(
        normalizedSourceCommitId,
        path,
        finding.line
      );
      const fingerprint = marker.match(/:([0-9a-f]{16}) -->$/i)?.[1];
      if (!fingerprint) throw new Error("failed to build Azure finding marker");
      desired.set(fingerprint, {
        finding: { ...finding, path },
        content: finding.body.trim() + "\n\n" + marker,
        changeTrackingId,
      });
    }

    for (const [fingerprint, entry] of desired) {
      const existing = before.find(
        (candidate) =>
          candidate.sourceCommitId === normalizedSourceCommitId &&
          candidate.fingerprint === fingerprint
      );

      if (existing) {
        await this.#updateReviewComment(
          existing.thread.id,
          existing.comment.id,
          entry.content
        );
        await this.#setThreadStatus(existing.thread.id, 1);
        continue;
      }

      const position = { line: entry.finding.line, offset: 1 };
      await this.#request<AzureDevOpsThread>("/threads?api-version=7.1", {
        method: "POST",
        body: JSON.stringify({
          comments: [
            {
              parentCommentId: 0,
              content: entry.content,
              commentType: 1,
            },
          ],
          status: 1,
          threadContext: {
            filePath: "/" + entry.finding.path,
            leftFileStart: null,
            leftFileEnd: null,
            rightFileStart: position,
            rightFileEnd: position,
          },
          pullRequestThreadContext: {
            changeTrackingId: entry.changeTrackingId,
            iterationContext: {
              // Azure iteration zero is the common source/target commit; the
              // model reviewed the cumulative PR diff against that base.
              firstComparingIteration: 0,
              secondComparingIteration: context.iterationId,
            },
          },
        }),
      });
    }

    // Re-list to converge concurrent same-location creates and close findings
    // that disappeared on a rerun or belong to an older source iteration.
    const after = this.#markedFindingThreads(await this.listThreads());
    const liveAfter =
      (await this.getLiveSourceCommitId()) ?? normalizedSourceCommitId;

    // The head can advance while this run is creating/updating its own threads.
    // In that race, neutralize only artifacts tagged with this run's source
    // commit and stop. Never evaluate or patch newer-source threads using this
    // run's stale desired findings.
    if (liveAfter !== normalizedSourceCommitId) {
      for (const entry of after) {
        if (entry.sourceCommitId === normalizedSourceCommitId) {
          await this.#setThreadStatus(entry.thread.id, 4);
        }
      }
      return { published: false, supersededBy: liveAfter };
    }

    const activeThreadIds: number[] = [];

    const grouped = new Map<string, typeof after>();
    for (const entry of after) {
      const key = entry.sourceCommitId + ":" + entry.fingerprint;
      const group = grouped.get(key) ?? [];
      group.push(entry);
      grouped.set(key, group);
    }

    for (const entry of after) {
      const isDesired =
        entry.sourceCommitId === normalizedSourceCommitId &&
        desired.has(entry.fingerprint);
      const group =
        grouped.get(entry.sourceCommitId + ":" + entry.fingerprint) ?? [];
      const canonical = group[0];
      const shouldBeActive = isDesired && canonical?.thread.id === entry.thread.id;
      await this.#setThreadStatus(entry.thread.id, shouldBeActive ? 1 : 4);
      if (shouldBeActive) activeThreadIds.push(entry.thread.id);
    }

    return {
      published: true,
      iterationId: context.iterationId,
      threadIds: activeThreadIds.sort((a, b) => a - b),
      skipped,
    };
  }

  async upsertReviewThread(
    markdown: string,
    sourceCommitId: string
  ): Promise<AzureDevOpsReviewPublication> {
    const normalizedSourceCommitId = sourceCommitId.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalizedSourceCommitId)) {
      throw new Error("invalid Azure DevOps source commit for review publication: " + sourceCommitId);
    }

    // A validation job may finish after a newer PR iteration. Never let that
    // older run replace the review for the current source commit.
    const liveBefore = await this.getLiveSourceCommitId();
    if (liveBefore && liveBefore !== normalizedSourceCommitId) {
      return { published: false, supersededBy: liveBefore };
    }

    const marker = azureDevOpsReviewMarker(normalizedSourceCommitId);
    const content = markdown.trim() + "\n\n" + marker;
    const before = this.#markedThreads(await this.listThreads()).filter(
      (entry) => entry.sourceCommitId === normalizedSourceCommitId
    );

    let created = false;
    let candidateThreadId: number;

    if (before.length > 0) {
      const canonical = before[0]!;
      await this.#updateReviewComment(canonical.thread.id, canonical.comment.id, content);
      await this.#setThreadStatus(canonical.thread.id, 1);
      candidateThreadId = canonical.thread.id;
    } else {
      const posted = await this.#request<AzureDevOpsThread>("/threads?api-version=7.1", {
        method: "POST",
        body: JSON.stringify({
          comments: [
            {
              parentCommentId: 0,
              content,
              commentType: 1,
            },
          ],
          status: 1,
        }),
      });
      created = true;
      candidateThreadId = posted.id;
    }

    // POST is not conditional, so two overlapping jobs can both create a
    // thread. Re-list after the write, choose the lowest ID as the stable
    // canonical thread for the current source commit, and close duplicates.
    const after = this.#markedThreads(await this.listThreads());
    const liveAfter = (await this.getLiveSourceCommitId()) ?? normalizedSourceCommitId;
    const liveThreads = after.filter((entry) => entry.sourceCommitId === liveAfter);
    const canonicalLive = liveThreads[0];

    for (const entry of after) {
      const shouldBeActive =
        entry.sourceCommitId === liveAfter && entry.thread.id === canonicalLive?.thread.id;
      await this.#setThreadStatus(entry.thread.id, shouldBeActive ? 1 : 4);
    }

    if (liveAfter !== normalizedSourceCommitId) {
      return { published: false, supersededBy: liveAfter };
    }

    // Another same-commit job may have won the create race with a lower ID.
    // Put this run's content on that canonical thread and return its ID.
    if (canonicalLive && canonicalLive.thread.id !== candidateThreadId) {
      await this.#updateReviewComment(
        canonicalLive.thread.id,
        canonicalLive.comment.id,
        content
      );
      candidateThreadId = canonicalLive.thread.id;
    }

    return { published: true, created, threadId: candidateThreadId };
  }
}
