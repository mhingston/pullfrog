import type {
  PullRequestReviewProvider,
  PullRequestSnapshot,
  ReviewPublication,
  ReviewPublicationResult,
} from "./types.ts";

interface GitHubPullRequestData {
  id: number;
  number: number;
  title: string;
  body?: string | null | undefined;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
  };
}

interface GitHubReviewData {
  id: number;
}

export interface GitHubReviewApi {
  pulls: {
    get(params: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: GitHubPullRequestData }>;
    createReview(params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
      event: "COMMENT";
      commit_id: string;
    }): Promise<{ data: GitHubReviewData }>;
  };
}

export class GitHubPullRequestProvider implements PullRequestReviewProvider {
  readonly #api: GitHubReviewApi;
  readonly #owner: string;
  readonly #repo: string;
  readonly #pullNumber: number;

  constructor(params: {
    api: GitHubReviewApi;
    owner: string;
    repo: string;
    pullNumber: number;
  }) {
    this.#api = params.api;
    this.#owner = params.owner;
    this.#repo = params.repo;
    this.#pullNumber = params.pullNumber;
  }

  async #get(): Promise<GitHubPullRequestData> {
    const response = await this.#api.pulls.get({
      owner: this.#owner,
      repo: this.#repo,
      pull_number: this.#pullNumber,
    });
    return response.data;
  }

  async getPullRequest(): Promise<PullRequestSnapshot> {
    const pullRequest = await this.#get();
    return {
      provider: "github",
      repository: { id: this.#owner + "/" + this.#repo },
      id: String(pullRequest.id),
      number: pullRequest.number,
      title: pullRequest.title,
      description: pullRequest.body ?? "",
      source: {
        ref: pullRequest.head.ref,
        sha: pullRequest.head.sha.toLowerCase(),
      },
      target: {
        ref: pullRequest.base.ref,
      },
    };
  }

  async publishReview(review: ReviewPublication): Promise<ReviewPublicationResult> {
    const live = await this.#get();
    const liveSha = live.head.sha.toLowerCase();
    const sourceSha = review.sourceSha.toLowerCase();

    if (liveSha !== sourceSha) {
      return {
        published: false,
        consistency: "best-effort",
        supersededBy: liveSha,
      };
    }

    const result = await this.#api.pulls.createReview({
      owner: this.#owner,
      repo: this.#repo,
      pull_number: this.#pullNumber,
      body: review.body,
      event: "COMMENT",
      commit_id: sourceSha,
    });

    // GitHub accepts reviews anchored to an older PR commit and does not offer
    // a conditional "publish only if head is still X" write. Re-read after the
    // POST so callers can distinguish a clean publication from a race we
    // detected after the stale review already exists.
    const after = await this.#get();
    const afterSha = after.head.sha.toLowerCase();

    return {
      published: true,
      created: true,
      id: String(result.data.id),
      consistency: "best-effort",
      ...(afterSha !== sourceSha ? { supersededBy: afterSha } : {}),
    };
  }
}
