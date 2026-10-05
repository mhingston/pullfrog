import type { AzureDevOpsRepositoryContext } from "./azureDevOps.ts";

export interface AzureDevOpsBuild {
  id: number;
  buildNumber?: string | undefined;
  status?: string | undefined;
  result?: string | undefined;
  sourceBranch?: string | undefined;
  sourceVersion?: string | undefined;
  definition?: { id?: number | undefined; name?: string | undefined } | undefined;
  repository?: { id?: string | undefined; name?: string | undefined } | undefined;
  triggerInfo?: Record<string, string | undefined> | undefined;
  parameters?: string | undefined;
  templateParameters?: Record<string, string | undefined> | undefined;
  url?: string | undefined;
}

export interface AzureDevOpsTimelineIssue {
  type?: string | undefined;
  category?: string | undefined;
  message?: string | undefined;
}

export interface AzureDevOpsTimelineRecord {
  id: string;
  parentId?: string | null | undefined;
  type?: string | undefined;
  name?: string | undefined;
  state?: string | undefined;
  result?: string | undefined;
  order?: number | undefined;
  log?: { id?: number | undefined; url?: string | undefined } | null | undefined;
  issues?: AzureDevOpsTimelineIssue[] | undefined;
}

interface AzureDevOpsTimeline {
  records?: AzureDevOpsTimelineRecord[] | undefined;
}

interface AzureDevOpsBuildList {
  value?: AzureDevOpsBuild[] | undefined;
  count?: number | undefined;
}

export interface AzureCiInterestingLine {
  line: number;
  type: "error" | "warning" | "failure" | "trace";
  content: string;
}

export interface AzureCiFailedLog {
  recordId: string;
  recordName: string;
  recordType: string;
  logId: number;
  result: string;
  issues: string[];
  totalLines: number;
  truncated: boolean;
  index: AzureCiInterestingLine[];
  excerpt: string;
}

export interface AzureCiFailureContext {
  build: AzureDevOpsBuild;
  failedLogs: AzureCiFailedLog[];
  truncated: boolean;
}

const MAX_LOGS = 12;
const MAX_LOG_CHARS = 40_000;
const MAX_TOTAL_CHARS = 160_000;
const MAX_INDEX_LINES = 100;
const EXCERPT_RADIUS = 40;

function normalizeSha(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{40}$/.test(normalized)
    ? normalized
    : undefined;
}

function triggerValue(
  build: AzureDevOpsBuild,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = build.triggerInfo?.[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function azureBuildPullRequestNumber(
  build: AzureDevOpsBuild
): number | undefined {
  const raw = triggerValue(
    build,
    "pr.number",
    "pr.id",
    "pullRequestId",
    "system.pullRequest.pullRequestId"
  );
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;

  const branchMatch = build.sourceBranch?.trim().match(
    /^refs\/pull\/(\d+)\/merge$/
  );
  const branchPr = Number(branchMatch?.[1]);
  return Number.isInteger(branchPr) && branchPr > 0 ? branchPr : undefined;
}

export function azureBuildPullRequestSourceSha(
  build: AzureDevOpsBuild
): string | undefined {
  return normalizeSha(
    triggerValue(
      build,
      "pr.sourceSha",
      "pr.sourceVersion",
      "system.pullRequest.sourceCommitId"
    )
  );
}

export function buildMatchesPullRequestSource(params: {
  build: AzureDevOpsBuild;
  pullRequestId: number;
  sourceSha: string;
  mergeSha?: string | undefined;
}): boolean {
  const expectedSha = normalizeSha(params.sourceSha);
  if (!expectedSha) {
    throw new Error("Azure build matching requires a valid PR source SHA");
  }

  const buildPr = azureBuildPullRequestNumber(params.build);
  if (buildPr !== undefined && buildPr !== params.pullRequestId) return false;

  const triggerSha = azureBuildPullRequestSourceSha(params.build);
  const headMatches =
    triggerSha !== undefined
      ? triggerSha === expectedSha
      : normalizeSha(params.build.sourceVersion) === expectedSha;
  if (!headMatches) return false;

  const expectedMergeSha = normalizeSha(params.mergeSha);
  if (params.mergeSha !== undefined && !expectedMergeSha) {
    throw new Error("Azure build matching requires a valid PR merge SHA");
  }
  if (expectedMergeSha) {
    const buildRevision = normalizeSha(params.build.sourceVersion);
    if (!buildRevision || buildRevision !== expectedMergeSha) return false;
  }

  return true;
}

function redactExact(value: string, secret: string): string {
  if (secret.length < 4) return value;
  return value.split(secret).join("[REDACTED]");
}

export function redactAzurePipelineLog(
  raw: string,
  secrets: readonly string[] = []
): string {
  let value = raw;

  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed) value = redactExact(value, trimmed);
  }

  value = value
    .replace(
      /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(SYSTEM_ACCESSTOKEN|AZURE_DEVOPS_TOKEN|AZURE_DEVOPS_PAT)\s*=\s*([^\s]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /(##vso\[task\.setvariable\s+[^\]]*issecret\s*=\s*true[^\]]*\])[^\r\n]*/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      "$1[REDACTED]@"
    );

  return value;
}

function classifyInterestingLine(
  line: string
): AzureCiInterestingLine["type"] | undefined {
  const patterns: Array<[
    AzureCiInterestingLine["type"],
    RegExp,
    RegExp | undefined,
  ]> = [
    ["error", /##\[error\]/i, undefined],
    ["error", /\berror(?:\s+[A-Z0-9_-]+)?\s*[:\]]/i, undefined],
    ["error", /exit code [1-9]/i, undefined],
    ["warning", /##\[warning\]/i, undefined],
    ["warning", /\bWARN(?:ING)?\b/i, /apt|dpkg|Reading package/i],
    ["failure", /\bFAIL(?:ED|URE)?\b/i, undefined],
    ["failure", /\d+ failed\b/i, undefined],
    ["failure", /✕|✗|×/, undefined],
    ["trace", /^\s+at\s+/i, undefined],
  ];

  for (const [type, pattern, skip] of patterns) {
    if (pattern.test(line) && !(skip?.test(line) ?? false)) return type;
  }
  return undefined;
}

export function analyzeAzurePipelineLog(
  raw: string,
  options?: {
    secrets?: readonly string[] | undefined;
    maxChars?: number | undefined;
  }
): {
  totalLines: number;
  truncated: boolean;
  index: AzureCiInterestingLine[];
  excerpt: string;
} {
  const sanitized = redactAzurePipelineLog(raw, options?.secrets ?? []);
  const maxChars = options?.maxChars ?? MAX_LOG_CHARS;
  const truncated = sanitized.length > maxChars;
  const bounded = truncated
    ? sanitized.slice(0, maxChars) +
      "\n[Pullfrog truncated this Azure Pipeline log for bounded model context.]"
    : sanitized;

  const lines = bounded.split(/\r?\n/);
  const index: AzureCiInterestingLine[] = [];
  let lastInteresting = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i] ?? "";
    const type = classifyInterestingLine(content);
    if (!type) continue;
    lastInteresting = i;
    if (index.length < MAX_INDEX_LINES) {
      index.push({ line: i + 1, type, content: content.slice(0, 1000) });
    }
  }

  const center = lastInteresting >= 0 ? lastInteresting : Math.max(0, lines.length - 1);
  const start = Math.max(0, center - EXCERPT_RADIUS);
  const end = Math.min(lines.length, center + EXCERPT_RADIUS + 1);
  const excerpt = lines
    .slice(start, end)
    .map((line, offset) => String(start + offset + 1).padStart(5, " ") + " | " + line)
    .join("\n");

  return {
    totalLines: sanitized.split(/\r?\n/).length,
    truncated,
    index,
    excerpt,
  };
}

export class AzureDevOpsBuildClient {
  readonly #ctx: AzureDevOpsRepositoryContext;

  constructor(ctx: AzureDevOpsRepositoryContext) {
    this.#ctx = ctx;
  }

  #url(path: string): string {
    const project = encodeURIComponent(this.#ctx.project);
    return new URL(
      project + "/_apis/build" + path,
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
        "Azure DevOps Build API failed: " +
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

  async #requestText(path: string): Promise<string> {
    const response = await fetch(this.#url(path), {
      headers: {
        Accept: "text/plain",
        Authorization: this.#ctx.authorization,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(
        "Azure DevOps Build log API failed: " +
          response.status +
          " " +
          response.statusText +
          (body ? " -- " + body : "")
      );
    }
    return await response.text();
  }

  async getBuild(buildId: number): Promise<AzureDevOpsBuild> {
    if (!Number.isInteger(buildId) || buildId <= 0) {
      throw new Error("Azure DevOps build id must be a positive integer");
    }
    return await this.#request<AzureDevOpsBuild>(
      "/builds/" + buildId + "?api-version=7.1"
    );
  }

  async listPullRequestBuilds(params: {
    pullRequestId: number;
    sourceSha: string;
    mergeSha?: string | undefined;
    max?: number | undefined;
  }): Promise<AzureDevOpsBuild[]> {
    const max = params.max ?? 25;
    if (!Number.isInteger(max) || max <= 0 || max > 100) {
      throw new Error("Azure DevOps PR build max must be between 1 and 100");
    }
    const sourceSha = normalizeSha(params.sourceSha);
    if (!sourceSha) {
      throw new Error("Azure DevOps PR build discovery requires a valid source SHA");
    }

    const query =
      "/builds?repositoryId=" +
      encodeURIComponent(this.#ctx.repositoryId) +
      "&reasonFilter=pullRequest&queryOrder=queueTimeDescending&$top=" +
      max +
      "&api-version=7.1";
    const response = await this.#request<AzureDevOpsBuildList>(query);
    return (response.value ?? []).filter((build) =>
      buildMatchesPullRequestSource({
        build,
        pullRequestId: params.pullRequestId,
        sourceSha,
        mergeSha: params.mergeSha,
      })
    );
  }

  async getTimeline(buildId: number): Promise<AzureDevOpsTimelineRecord[]> {
    if (!Number.isInteger(buildId) || buildId <= 0) {
      throw new Error("Azure DevOps build id must be a positive integer");
    }
    const timeline = await this.#request<AzureDevOpsTimeline>(
      "/builds/" + buildId + "/timeline?api-version=7.1"
    );
    return timeline.records ?? [];
  }

  async collectFailureContext(params: {
    buildId: number;
    pullRequestId: number;
    sourceSha: string;
    mergeSha?: string | undefined;
    secrets?: readonly string[] | undefined;
  }): Promise<AzureCiFailureContext> {
    const build = await this.getBuild(params.buildId);
    if (
      !buildMatchesPullRequestSource({
        build,
        pullRequestId: params.pullRequestId,
        sourceSha: params.sourceSha,
        mergeSha: params.mergeSha,
      })
    ) {
      throw new Error(
        "Azure DevOps build does not belong to the expected PR/source revision"
      );
    }

    const timeline = await this.getTimeline(params.buildId);
    const failed = timeline
      .filter(
        (record) =>
          record.result?.toLowerCase() === "failed" &&
          Number.isInteger(record.log?.id) &&
          (record.log?.id ?? 0) > 0
      )
      .sort((left, right) => {
        const order = (left.order ?? 0) - (right.order ?? 0);
        return order !== 0 ? order : left.id.localeCompare(right.id);
      });

    const seenLogs = new Set<number>();
    const failedLogs: AzureCiFailedLog[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const record of failed) {
      const logId = record.log!.id!;
      if (seenLogs.has(logId)) continue;
      seenLogs.add(logId);
      if (failedLogs.length >= MAX_LOGS || totalChars >= MAX_TOTAL_CHARS) {
        truncated = true;
        break;
      }

      const raw = await this.#requestText(
        "/builds/" +
          params.buildId +
          "/logs/" +
          logId +
          "?api-version=7.1"
      );
      const remaining = Math.max(1, MAX_TOTAL_CHARS - totalChars);
      const maxChars = Math.min(MAX_LOG_CHARS, remaining);
      const analysis = analyzeAzurePipelineLog(raw, {
        secrets: params.secrets,
        maxChars,
      });
      totalChars += Math.min(raw.length, maxChars);
      if (analysis.truncated) truncated = true;

      failedLogs.push({
        recordId: record.id,
        recordName: record.name ?? "(unnamed failed step)",
        recordType: record.type ?? "unknown",
        logId,
        result: record.result ?? "failed",
        issues: (record.issues ?? [])
          .map((issue) => issue.message?.trim())
          .filter((message): message is string => Boolean(message))
          .map((message) =>
            redactAzurePipelineLog(message, params.secrets ?? []).slice(0, 2000)
          ),
        ...analysis,
      });
    }

    if (failedLogs.length === 0) {
      throw new Error(
        "Azure DevOps build has no failed timeline records with readable logs"
      );
    }

    return { build, failedLogs, truncated };
  }

  async requeueBuild(params: {
    buildId: number;
    pullRequestId: number;
    sourceSha: string;
    mergeSha?: string | undefined;
  }): Promise<AzureDevOpsBuild> {
    const build = await this.getBuild(params.buildId);
    if (
      !buildMatchesPullRequestSource({
        build,
        pullRequestId: params.pullRequestId,
        sourceSha: params.sourceSha,
        mergeSha: params.mergeSha,
      })
    ) {
      throw new Error(
        "refusing to requeue Azure build for a different PR/source revision"
      );
    }

    const definitionId = build.definition?.id;
    const sourceBranch = build.sourceBranch?.trim();
    const sourceVersion = build.sourceVersion?.trim();
    if (!Number.isInteger(definitionId) || (definitionId ?? 0) <= 0) {
      throw new Error("Azure DevOps build is missing a valid definition id");
    }
    if (!sourceBranch) {
      throw new Error("Azure DevOps build is missing sourceBranch");
    }
    if (!sourceVersion) {
      throw new Error("Azure DevOps build is missing sourceVersion");
    }

    return await this.#request<AzureDevOpsBuild>("/builds?api-version=7.1", {
      method: "POST",
      body: JSON.stringify({
        definition: { id: definitionId },
        sourceBranch,
        sourceVersion,
        ...(build.parameters ? { parameters: build.parameters } : {}),
        ...(build.templateParameters
          ? { templateParameters: build.templateParameters }
          : {}),
      }),
    });
  }
}
