import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const AZDO_REVIEW_MARKER_PREFIX = "<!-- pullfrog-azure-devops-review:";
export const AZDO_FINDING_MARKER_PREFIX = "<!-- pullfrog-azure-devops-finding:";
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

export interface AzureDevOpsContext {
  collectionUri: string;
  project: string;
  repositoryId: string;
  repositoryUri: string;
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
  const repositoryUri = required("BUILD_REPOSITORY_URI", env.BUILD_REPOSITORY_URI);
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
    repositoryUri,
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

    const before = this.#markedFindingThreads(await this.#listThreads());
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
    const after = this.#markedFindingThreads(await this.#listThreads());
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
