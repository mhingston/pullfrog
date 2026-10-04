import type {
  PullRequestReviewProvider,
  PullRequestSnapshot,
  ReviewPublicationResult,
} from "./types.ts";

export interface PullRequestReviewRun {
  pullRequest: PullRequestSnapshot;
  body: string;
  publication?: ReviewPublicationResult | undefined;
}

export async function runPullRequestReview(params: {
  provider: PullRequestReviewProvider;
  review: (pullRequest: PullRequestSnapshot) => Promise<string>;
  dryRun?: boolean | undefined;
}): Promise<PullRequestReviewRun> {
  const pullRequest = await params.provider.getPullRequest();
  const body = await params.review(pullRequest);

  if (params.dryRun) {
    return { pullRequest, body };
  }

  const publication = await params.provider.publishReview({
    body,
    sourceSha: pullRequest.source.sha,
  });

  return { pullRequest, body, publication };
}
