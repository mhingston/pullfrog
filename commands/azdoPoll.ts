import {
  type AzureDevOpsComment,
  type AzureDevOpsThread,
} from "../utils/azureDevOps.ts";
import { selectAzureFollowUp } from "./azdoFollowUp.ts";

export interface AzurePollingCandidate {
  pullRequestId: number;
  threadId: number;
  commentId: number;
  actorId: string;
  publishedAt: string;
}

export function parseAzureAllowedActorIds(raw: string | undefined): Set<string> {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(
      "automatic Azure follow-up polling requires at least one allowed actor id"
    );
  }
  return new Set(values);
}

export function parseAzurePollAfter(raw: string | undefined): Date {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      "automatic Azure follow-up polling requires --after or PULLFROG_AZDO_POLL_AFTER"
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("invalid Azure follow-up polling cutoff: " + value);
  }
  return parsed;
}

function publishedAt(comment: AzureDevOpsComment): Date | undefined {
  const value = comment.publishedDate?.trim();
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function selectAzurePollingCandidates(params: {
  pullRequestId: number;
  threads: AzureDevOpsThread[];
  allowedActorIds: Set<string>;
  after: Date;
  max?: number | undefined;
}): AzurePollingCandidate[] {
  const max = params.max ?? 10;
  if (!Number.isInteger(max) || max <= 0 || max > 50) {
    throw new Error("Azure follow-up polling max must be between 1 and 50");
  }

  const candidates: AzurePollingCandidate[] = [];

  for (const thread of [...params.threads].sort((a, b) => a.id - b.id)) {
    const comments = [...(thread.comments ?? [])]
      .filter((comment) => !comment.isDeleted)
      .sort((a, b) => a.id - b.id);

    for (const comment of comments) {
      const actorId = comment.author?.id?.trim().toLowerCase();
      if (!actorId || !params.allowedActorIds.has(actorId)) continue;

      const date = publishedAt(comment);
      if (!date || date < params.after) continue;

      const selection = selectAzureFollowUp({
        thread,
        commentId: comment.id,
      });
      if (selection.kind !== "trigger") continue;

      candidates.push({
        pullRequestId: params.pullRequestId,
        threadId: thread.id,
        commentId: comment.id,
        actorId,
        publishedAt: date.toISOString(),
      });
    }
  }

  return candidates
    .sort((left, right) => {
      const byTime = left.publishedAt.localeCompare(right.publishedAt);
      if (byTime !== 0) return byTime;
      if (left.pullRequestId !== right.pullRequestId) {
        return left.pullRequestId - right.pullRequestId;
      }
      if (left.threadId !== right.threadId) return left.threadId - right.threadId;
      return left.commentId - right.commentId;
    })
    .slice(0, max);
}
