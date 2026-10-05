import type { AzureDevOpsRepositoryContext } from "../utils/azureDevOps.ts";
import type {
  WorkItemComment,
  WorkItemDiscussion,
  WorkItemIdentity,
  WorkItemMutation,
  WorkItemProvider,
  WorkItemRelation,
  WorkItemSearchResult,
  WorkItemSnapshot,
} from "./workItems.ts";

const API_VERSION = "7.1";
const COMMENTS_API_VERSION = "7.1-preview.4";
const MAX_COMMENTS = 500;
const MAX_DISCUSSION_CHARS = 200_000;
const TERM = /^[\p{L}\p{N}_./-]+$/u;

interface AzureIdentityRef {
  id?: string | undefined;
  displayName?: string | undefined;
  uniqueName?: string | undefined;
}

interface AzureWorkItemRelation {
  rel?: string | undefined;
  url?: string | undefined;
  attributes?: {
    name?: string | undefined;
    comment?: string | undefined;
  } | undefined;
}

interface AzureWorkItem {
  id: number;
  rev: number;
  url?: string | undefined;
  fields?: Record<string, unknown> | undefined;
  relations?: AzureWorkItemRelation[] | undefined;
}

interface AzureWorkItemComment {
  id: number;
  text?: string | null | undefined;
  createdBy?: AzureIdentityRef | undefined;
  createdDate?: string | undefined;
  modifiedDate?: string | undefined;
}

interface AzureWorkItemCommentsResponse {
  comments?: AzureWorkItemComment[] | undefined;
  count?: number | undefined;
  totalCount?: number | undefined;
  continuationToken?: string | undefined;
}

interface AzureWiqlResponse {
  workItems?: Array<{ id: number; url?: string | undefined }> | undefined;
}

type JsonPatchOperation =
  | { op: "test"; path: "/rev"; value: number }
  | { op: "add" | "replace"; path: string; value: unknown };

const CHANGED_WORK_ITEM_PAGE_SIZE = 100;
const CHANGED_WORK_ITEM_FETCH_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function identity(value: unknown): WorkItemIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as AzureIdentityRef;
  const id = candidate.id?.trim();
  if (!id) return undefined;
  return {
    id,
    ...(candidate.displayName?.trim()
      ? { displayName: candidate.displayName.trim() }
      : {}),
    ...(candidate.uniqueName?.trim()
      ? { uniqueName: candidate.uniqueName.trim() }
      : {}),
  };
}

function fieldString(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  return typeof value === "string" ? value : "";
}

function splitTags(value: string): string[] {
  return value
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === tag.toLowerCase()) === index);
}

function workItemRelationId(url: string): string | undefined {
  const match = url.match(/\/_apis\/wit\/workitems\/(\d+)(?:\?|$)/i);
  return match?.[1];
}

function artifactParts(url: string): string[] {
  const marker = "vstfs:///";
  if (!url.toLowerCase().startsWith(marker)) return [];
  try {
    return decodeURIComponent(url.slice(marker.length)).split("/");
  } catch {
    return [];
  }
}

function relation(value: AzureWorkItemRelation): WorkItemRelation | undefined {
  const rel = value.rel?.trim();
  const url = value.url?.trim();
  if (!rel || !url) return undefined;

  if (rel === "Hyperlink") {
    return {
      kind: "hyperlink",
      relation: rel,
      url,
      ...(value.attributes?.comment?.trim()
        ? { name: value.attributes.comment.trim() }
        : {}),
    };
  }

  const workItemId = workItemRelationId(url);
  if (workItemId) {
    return {
      kind: "work-item",
      relation: rel,
      url,
      id: workItemId,
      ...(value.attributes?.name?.trim()
        ? { name: value.attributes.name.trim() }
        : {}),
    };
  }

  if (rel === "ArtifactLink") {
    const parts = artifactParts(url);
    const artifactType = parts[1]?.toLowerCase();
    const payload = parts.slice(2).join("/");
    const ids = payload.split("/").filter(Boolean);
    if (artifactType === "pullrequestid") {
      return {
        kind: "pull-request",
        relation: rel,
        url,
        ...(ids.at(-1) ? { id: ids.at(-1)! } : {}),
        ...(value.attributes?.name?.trim()
          ? { name: value.attributes.name.trim() }
          : {}),
      };
    }
    if (artifactType === "commit") {
      return {
        kind: "commit",
        relation: rel,
        url,
        ...(ids.at(-1) ? { id: ids.at(-1)! } : {}),
        ...(value.attributes?.name?.trim()
          ? { name: value.attributes.name.trim() }
          : {}),
      };
    }
  }

  return {
    kind: "artifact",
    relation: rel,
    url,
    ...(value.attributes?.name?.trim()
      ? { name: value.attributes.name.trim() }
      : {}),
  };
}

function normalizeWorkItem(
  ctx: AzureDevOpsRepositoryContext,
  item: AzureWorkItem
): WorkItemSnapshot {
  if (!Number.isInteger(item.id) || item.id <= 0) {
    throw new Error("Azure Boards returned an invalid work-item id");
  }
  if (!Number.isInteger(item.rev) || item.rev <= 0) {
    throw new Error("Azure Boards returned an invalid work-item revision");
  }
  const fields = item.fields ?? {};
  const relations = (item.relations ?? [])
    .map(relation)
    .filter((entry): entry is WorkItemRelation => entry !== undefined);

  return {
    provider: "azure-devops",
    project: ctx.project,
    repository: { id: ctx.repositoryId },
    id: item.id,
    revision: item.rev,
    type: fieldString(fields, "System.WorkItemType") || "Work Item",
    title: fieldString(fields, "System.Title"),
    description:
      fieldString(fields, "System.Description") ||
      fieldString(fields, "Microsoft.VSTS.TCM.ReproSteps"),
    state: fieldString(fields, "System.State"),
    tags: splitTags(fieldString(fields, "System.Tags")),
    assignedTo: identity(fields["System.AssignedTo"]),
    author: identity(fields["System.CreatedBy"]),
    ...(fieldString(fields, "System.CreatedDate")
      ? { createdAt: fieldString(fields, "System.CreatedDate") }
      : {}),
    ...(fieldString(fields, "System.ChangedDate")
      ? { changedAt: fieldString(fields, "System.ChangedDate") }
      : {}),
    relations,
  };
}

function normalizeComment(comment: AzureWorkItemComment): WorkItemComment {
  if (!Number.isInteger(comment.id) || comment.id <= 0) {
    throw new Error("Azure Boards returned an invalid comment id");
  }
  return {
    id: comment.id,
    body: comment.text ?? "",
    author: identity(comment.createdBy),
    ...(comment.createdDate ? { createdAt: comment.createdDate } : {}),
    ...(comment.modifiedDate ? { modifiedAt: comment.modifiedDate } : {}),
  };
}

function validateWorkItemId(id: number): number {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Azure Boards work-item id must be a positive integer");
  }
  return id;
}

function validateTag(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed || trimmed.length > 256 || /[;,]/.test(trimmed)) {
    throw new Error("Azure Boards tag must be 1-256 characters and cannot contain ';' or ','");
  }
  return trimmed;
}

function validateState(state: string): string {
  const trimmed = state.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n]/.test(trimmed)) {
    throw new Error("Azure Boards state must be a non-empty single-line value");
  }
  return trimmed;
}

function escapeWiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export class AzureDevOpsBoardsProvider implements WorkItemProvider {
  readonly #ctx: AzureDevOpsRepositoryContext;

  constructor(ctx: AzureDevOpsRepositoryContext) {
    this.#ctx = ctx;
  }

  #projectUrl(path: string): string {
    return new URL(
      encodeURIComponent(this.#ctx.project) + path,
      this.#ctx.collectionUri
    ).toString();
  }

  async #fetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", this.#ctx.authorization);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(this.#projectUrl(path), {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(
        "Azure Boards API failed: " +
          response.status +
          " " +
          response.statusText +
          (body ? " -- " + body : "")
      );
    }
    return response;
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.#fetch(path, init);
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async getWorkItem(id: number): Promise<WorkItemSnapshot> {
    validateWorkItemId(id);
    const item = await this.#json<AzureWorkItem>(
      "/_apis/wit/workitems/" +
        id +
        "?$expand=relations&api-version=" +
        API_VERSION
    );
    return normalizeWorkItem(this.#ctx, item);
  }

  async getComments(id: number): Promise<WorkItemDiscussion> {
    validateWorkItemId(id);
    const comments: WorkItemComment[] = [];
    let continuationToken: string | undefined;
    let chars = 0;
    let truncated = false;

    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({
        "$top": "100",
        "api-version": COMMENTS_API_VERSION,
      });
      if (continuationToken) query.set("continuationToken", continuationToken);
      const response = await this.#fetch(
        "/_apis/wit/workitems/" + id + "/comments?" + query.toString()
      );
      const headerToken = response.headers.get("x-ms-continuationtoken")?.trim();
      const body = (await response.json()) as AzureWorkItemCommentsResponse;

      for (const raw of body.comments ?? []) {
        const normalized = normalizeComment(raw);
        if (
          comments.length >= MAX_COMMENTS ||
          chars + normalized.body.length > MAX_DISCUSSION_CHARS
        ) {
          truncated = true;
          break;
        }
        comments.push(normalized);
        chars += normalized.body.length;
      }
      if (truncated) break;

      continuationToken = headerToken || body.continuationToken?.trim();
      if (!continuationToken) break;
      if (page === 49) truncated = true;
    }

    return { comments, truncated };
  }

  async addComment(id: number, body: string): Promise<WorkItemComment> {
    validateWorkItemId(id);
    const text = body.trim();
    if (!text) throw new Error("Azure Boards comment must not be empty");
    if (text.length > 100_000) {
      throw new Error("Azure Boards comment must be 100000 characters or fewer");
    }
    const comment = await this.#json<AzureWorkItemComment>(
      "/_apis/wit/workitems/" +
        id +
        "/comments?format=markdown&api-version=" +
        COMMENTS_API_VERSION,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      }
    );
    return normalizeComment(comment);
  }

  async editComment(
    id: number,
    commentId: number,
    body: string
  ): Promise<WorkItemComment> {
    validateWorkItemId(id);
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error("Azure Boards comment id must be a positive integer");
    }
    const text = body.trim();
    if (!text) throw new Error("Azure Boards comment must not be empty");
    if (text.length > 100_000) {
      throw new Error("Azure Boards comment must be 100000 characters or fewer");
    }
    const comment = await this.#json<AzureWorkItemComment>(
      "/_apis/wit/workitems/" +
        id +
        "/comments/" +
        commentId +
        "?format=markdown&api-version=" +
        COMMENTS_API_VERSION,
      {
        method: "PATCH",
        body: JSON.stringify({ text }),
      }
    );
    return normalizeComment(comment);
  }

  async updateWorkItem(params: {
    id: number;
    expectedRevision: number;
    mutations: WorkItemMutation[];
  }): Promise<WorkItemSnapshot> {
    validateWorkItemId(params.id);
    if (!Number.isInteger(params.expectedRevision) || params.expectedRevision <= 0) {
      throw new Error("Azure Boards update requires a positive expected revision");
    }
    if (params.mutations.length === 0) {
      throw new Error("Azure Boards update requires at least one allowlisted mutation");
    }
    if (params.mutations.length > 20) {
      throw new Error("Azure Boards update is limited to 20 mutations");
    }

    const current = await this.getWorkItem(params.id);
    if (current.revision !== params.expectedRevision) {
      throw new Error(
        "Azure Boards update blocked: work item advanced from revision " +
          params.expectedRevision +
          " to " +
          current.revision
      );
    }

    const patch: JsonPatchOperation[] = [
      { op: "test", path: "/rev", value: params.expectedRevision },
    ];
    let tags = [...current.tags];

    for (const mutation of params.mutations) {
      if (mutation.kind === "tags") {
        const removals = new Set(
          (mutation.remove ?? []).map(validateTag).map((tag) => tag.toLowerCase())
        );
        tags = tags.filter((tag) => !removals.has(tag.toLowerCase()));
        for (const candidate of mutation.add ?? []) {
          const tag = validateTag(candidate);
          if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
            tags.push(tag);
          }
        }
        patch.push({
          op: "add",
          path: "/fields/System.Tags",
          value: tags.join("; "),
        });
        continue;
      }
      if (mutation.kind === "state") {
        patch.push({
          op: "add",
          path: "/fields/System.State",
          value: validateState(mutation.state),
        });
        continue;
      }
      if (mutation.kind === "hyperlink") {
        const url = mutation.url.trim();
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error("Azure Boards hyperlink mutation requires an absolute URL");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Azure Boards hyperlink mutation requires http/https");
        }
        patch.push({
          op: "add",
          path: "/relations/-",
          value: {
            rel: "Hyperlink",
            url: parsed.toString(),
            attributes: {
              comment: mutation.comment?.trim() || "Pullfrog related artifact",
            },
          },
        });
        continue;
      }
      throw new Error("Azure Boards update received an unsupported mutation kind");
    }

    const updated = await this.#json<AzureWorkItem>(
      "/_apis/wit/workitems/" + params.id + "?api-version=" + API_VERSION,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json-patch+json",
        },
        body: JSON.stringify(patch),
      }
    );
    return normalizeWorkItem(this.#ctx, updated);
  }

  async searchWorkItems(params: {
    terms: string[];
    excludeId?: number | undefined;
    max?: number | undefined;
  }): Promise<{ items: WorkItemSearchResult[]; incomplete: boolean }> {
    if (params.terms.length < 1 || params.terms.length > 5) {
      throw new Error("Azure Boards search requires 1-5 terms");
    }
    const terms = params.terms.map((term) => {
      if (!TERM.test(term) || term.length > 40) {
        throw new Error(
          "Azure Boards search terms may contain only letters, digits and _ . / - and must be 40 characters or fewer"
        );
      }
      return term;
    });
    const max = params.max ?? 20;
    if (!Number.isInteger(max) || max <= 0 || max > 20) {
      throw new Error("Azure Boards search max must be between 1 and 20");
    }

    const clauses = terms.map((term) => {
      const value = escapeWiqlLiteral(term);
      return (
        "([System.Title] CONTAINS '" +
        value +
        "' OR [System.Description] CONTAINS '" +
        value +
        "')"
      );
    });
    if (params.excludeId !== undefined) {
      validateWorkItemId(params.excludeId);
      clauses.push("[System.Id] <> " + params.excludeId);
    }
    const query =
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND " +
      clauses.join(" AND ") +
      " ORDER BY [System.ChangedDate] DESC";

    const result = await this.#json<AzureWiqlResponse>(
      "/_apis/wit/wiql?$top=" + (max + 1) + "&api-version=" + API_VERSION,
      {
        method: "POST",
        body: JSON.stringify({ query }),
      }
    );
    const ids = (result.workItems ?? []).map((item) => item.id);
    const incomplete = ids.length > max;
    const selected = ids.slice(0, max);
    const snapshots = await Promise.all(selected.map((id) => this.getWorkItem(id)));
    const items: WorkItemSearchResult[] = snapshots.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      type: item.type,
      url: this.workItemWebUrl(item.id),
    }));
    return { items, incomplete };
  }

  async listChangedWorkItems(params: {
    after: Date;
    max?: number | undefined;
  }): Promise<{ items: WorkItemSnapshot[]; incomplete: boolean }> {
    if (!Number.isFinite(params.after.getTime())) {
      throw new Error("Azure Boards changed-work-item cutoff is invalid");
    }
    const max = params.max ?? 5_000;
    if (!Number.isInteger(max) || max <= 0 || max > 10_000) {
      throw new Error(
        "Azure Boards changed-work-item scan max must be between 1 and 10000"
      );
    }

    const cutoff = params.after.toISOString();
    const items: WorkItemSnapshot[] = [];
    let cursorId = 0;

    while (items.length < max) {
      const take = Math.min(
        CHANGED_WORK_ITEM_PAGE_SIZE,
        max - items.length
      );
      const query =
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project " +
        "AND [System.ChangedDate] >= '" +
        escapeWiqlLiteral(cutoff) +
        "' " +
        (cursorId > 0 ? "AND [System.Id] > " + cursorId + " " : "") +
        "ORDER BY [System.Id] ASC";
      const result = await this.#json<AzureWiqlResponse>(
        "/_apis/wit/wiql?$top=" + (take + 1) + "&api-version=" + API_VERSION,
        {
          method: "POST",
          body: JSON.stringify({ query }),
        }
      );
      const page = result.workItems ?? [];
      const selectedIds = page.slice(0, take).map((item) => item.id);
      if (selectedIds.length === 0) {
        return { items, incomplete: false };
      }

      const snapshots = await mapWithConcurrency(
        selectedIds,
        CHANGED_WORK_ITEM_FETCH_CONCURRENCY,
        (id) => this.getWorkItem(id)
      );
      items.push(...snapshots);
      cursorId = selectedIds[selectedIds.length - 1]!;

      if (page.length <= take) {
        return { items, incomplete: false };
      }
      if (items.length >= max) {
        return { items, incomplete: true };
      }
    }

    return { items, incomplete: true };
  }

  workItemWebUrl(id: number): string {
    validateWorkItemId(id);
    return new URL(
      encodeURIComponent(this.#ctx.project) + "/_workitems/edit/" + id,
      this.#ctx.collectionUri
    ).toString();
  }
}
