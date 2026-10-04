import { execFileSync } from "node:child_process";

export const AZDO_REVIEW_MARKER = "<!-- pullfrog-azure-devops-review -->";

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
}

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
      "refs/heads/" + params.branch + ":" + remoteRef,
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

  async upsertReviewThread(markdown: string): Promise<{ created: boolean; threadId: number }> {
    const content = markdown.trim() + "\n\n" + AZDO_REVIEW_MARKER;
    const threads = await this.#request<AzureDevOpsList<AzureDevOpsThread>>(
      "/threads?api-version=7.1"
    );

    for (const thread of threads.value) {
      if (thread.isDeleted) continue;
      const comment = thread.comments?.find(
        (candidate) =>
          !candidate.isDeleted &&
          typeof candidate.content === "string" &&
          candidate.content.includes(AZDO_REVIEW_MARKER)
      );
      if (!comment) continue;

      await this.#request(
        "/threads/" + thread.id + "/comments/" + comment.id + "?api-version=7.1",
        {
          method: "PATCH",
          body: JSON.stringify({
            id: comment.id,
            content,
            commentType: 1,
          }),
        }
      );
      return { created: false, threadId: thread.id };
    }

    const created = await this.#request<AzureDevOpsThread>("/threads?api-version=7.1", {
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

    return { created: true, threadId: created.id };
  }
}
