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

export type ReviewPublicationResult =
  | {
      published: true;
      created: boolean;
      id: string;
    }
  | {
      published: false;
      supersededBy: string;
    };

export interface PullRequestReader {
  getPullRequest(): Promise<PullRequestSnapshot>;
}

export interface ReviewPublisher {
  publishReview(review: ReviewPublication): Promise<ReviewPublicationResult>;
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
