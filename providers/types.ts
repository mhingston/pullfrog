export type PullRequestProviderId = "github" | "azure-devops";

export interface RepositoryRef {
  id: string;
}

export interface PullRequestRef {
  id: string;
  number: number;
}

export interface PullRequestSnapshot extends PullRequestRef {
  provider: PullRequestProviderId;
  repository: RepositoryRef;
  title: string;
  description: string;
  source: {
    ref: string;
    sha: string;
  };
  target: {
    ref: string;
  };
}

export interface ReviewPublication {
  body: string;
  sourceSha: string;
}

export type ReviewPublicationConsistency = "source-convergent" | "best-effort";

/**
 * Publication is not a cross-provider compare-and-swap operation.
 *
 * "source-convergent" means the adapter revalidates around the write and can
 * converge/neutralize a stale provider artifact when the platform allows it.
 * "best-effort" means the provider has no conditional-write primitive; a head
 * can advance during publication. In that case a successful publication may
 * include `supersededBy` when the adapter detects the race after the write.
 */
export type ReviewPublicationResult =
  | {
      published: true;
      created: boolean;
      id: string;
      consistency: ReviewPublicationConsistency;
      supersededBy?: string | undefined;
    }
  | {
      published: false;
      consistency: ReviewPublicationConsistency;
      supersededBy: string;
    };

export interface PullRequestReader {
  getPullRequest(): Promise<PullRequestSnapshot>;
}

export interface ReviewPublisher {
  publishReview(review: ReviewPublication): Promise<ReviewPublicationResult>;
}

export interface PullRequestDescriptionUpdate {
  description: string;
}

export interface PullRequestDescriptionMutationResult extends PullRequestRef {
  provider: PullRequestProviderId;
  repository: RepositoryRef;
  title: string;
  description: string;
}

export interface PullRequestDescriptionMutator {
  updatePullRequestDescription(
    update: PullRequestDescriptionUpdate
  ): Promise<PullRequestDescriptionMutationResult>;
}

export type PullRequestReviewProvider = PullRequestReader & ReviewPublisher;

export type PullRequestEventKind =
  | "opened"
  | "updated"
  | "comment"
  | "review"
  | "validation";

export interface PullRequestEvent {
  provider: PullRequestProviderId;
  repository: RepositoryRef;
  pullRequest: PullRequestRef;
  sourceSha: string;
  kind: PullRequestEventKind;
  providerEventId?: string | undefined;
}
