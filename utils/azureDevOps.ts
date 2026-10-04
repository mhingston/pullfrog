import { execFileSync } from "node:child_process";

export const AZDO_REVIEW_MARKER_PREFIX = "<!-- pullfrog-azure-devops-review:";

export function azureDevOpsReviewMarker(sourceCommitId: string): string {
  return AZDO_REVIEW_MARKER_PREFIX + sourceCommitId.toLowerCase() + " -->";
}

export interface AzureDevOpsContext {
  collectionUri: string;
  project: string;
  repositoryId: string;
  pullRequestId: number;
  sourceBranch: string;
  sourceCommitId: string;
  targetBranch: string;
  authorization: string;
}

interface AzureDevOpsPullRequest {
  pullRequestId: number;
  title: string;
  description?: string | null;
  sourceRefName: string;
  targetRefName: string;
  createdBy?: { displayName?: string | undefined } | undefined;
  lastMergeSourceCommit?: { commitId?: string | undefined } | undefined;
  url?: string | undefined;
}

interface AzureDevOpsComment {
  id: number;
  content?: string | null;
  isDeleted?: boolean | undefined;
}

interface AzureDevOpsThread {
  id: number;
  comments?: AzureDevOpsComment[] | undefined;
  isDeleted?: boolean | undefined;
  status?: number | string | undefined;
}

export type AzureDevOpsReviewPublication =
  | { published: true; created: boolean; threadId: number }
  | { published: false; supersededBy: string };

interface AzureDevOpsList<T> {
  value: T[];
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

export function resolveAzureDevOpsContext(
  env: NodeJS.ProcessEnv = process.env
): AzureDevOpsContext {
  const collectionUri = required(
    "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI",
    env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || env.SYSTEM_COLLECTIONURI
  ).replace(/\/*$/, "/");
  const project = required("SYSTEM_TEAMPROJECT", env.SYSTEM_TEAMPROJECT);
  const repositoryId = required("BUILD_REPOSITORY_ID", env.BUILD_REPOSITORY_ID);
  const repositoryProvider = env.BUILD_REPOSITORY_PROVIDER?.trim();
  if (repositoryProvider && repositoryProvider !== "TfsGit") {
    throw new Error(
      "pullfrog azdo review currently supports Azure Repos Git only; BUILD_REPOSITORY_PROVIDER=" +
        repositoryProvider
    );
  }
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
    collectionUri,
    project,
    repositoryId,
    pullRequestId,
    sourceBranch,
    sourceCommitId,
    targetBranch,
    authorization: buildAzureDevOpsAuthorization(env),
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

export class AzureDevOpsClient {
  readonly #ctx: AzureDevOpsContext;

  constructor(ctx: AzureDevOpsContext) {
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

    return (await response.json()) as T;
  }

  async getPullRequest(): Promise<AzureDevOpsPullRequest> {
    return await this.#request<AzureDevOpsPullRequest>("?api-version=7.1");
  }

  async #listThreads(): Promise<AzureDevOpsThread[]> {
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

  async #liveSourceCommitId(): Promise<string | undefined> {
    return (await this.getPullRequest()).lastMergeSourceCommit?.commitId?.toLowerCase();
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
    const liveBefore = await this.#liveSourceCommitId();
    if (liveBefore && liveBefore !== normalizedSourceCommitId) {
      return { published: false, supersededBy: liveBefore };
    }

    const marker = azureDevOpsReviewMarker(normalizedSourceCommitId);
    const content = markdown.trim() + "\n\n" + marker;
    const before = this.#markedThreads(await this.#listThreads()).filter(
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
    const after = this.#markedThreads(await this.#listThreads());
    const liveAfter = (await this.#liveSourceCommitId()) ?? normalizedSourceCommitId;
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
