import {
  AzureDevOpsClient,
  type AzureDevOpsContext,
  type AzureDevOpsReviewPublication,
  stripRefsHeads,
} from "../utils/azureDevOps.ts";
import type {
  PullRequestDescriptionMutator,
  PullRequestDescriptionMutationResult,
  PullRequestDescriptionUpdate,
  PullRequestEvent,
  PullRequestReviewProvider,
  PullRequestSnapshot,
  ReviewPublication,
  ReviewPublicationResult,
} from "./types.ts";

interface AzureDevOpsPullRequestData {
  pullRequestId: number;
  title: string;
  description?: string | null | undefined;
  sourceRefName: string;
  targetRefName: string;
}

export interface AzureDevOpsReviewApi {
  getPullRequest(): Promise<AzureDevOpsPullRequestData>;
  upsertReviewThread(
    markdown: string,
    sourceCommitId: string
  ): Promise<AzureDevOpsReviewPublication>;
}

export interface AzureDevOpsMutationApi {
  updatePullRequestDescription(
    description: string
  ): Promise<AzureDevOpsPullRequestData>;
}

export class AzureDevOpsPullRequestDescriptionMutator
  implements PullRequestDescriptionMutator
{
  readonly #ctx: AzureDevOpsContext;
  readonly #client: AzureDevOpsMutationApi;

  constructor(
    ctx: AzureDevOpsContext,
    client: AzureDevOpsMutationApi = new AzureDevOpsClient(ctx)
  ) {
    this.#ctx = ctx;
    this.#client = client;
  }

  async updatePullRequestDescription(
    update: PullRequestDescriptionUpdate
  ): Promise<PullRequestDescriptionMutationResult> {
    const pullRequest = await this.#client.updatePullRequestDescription(
      update.description
    );
    if (pullRequest.pullRequestId !== this.#ctx.pullRequestId) {
      throw new Error(
        "Azure DevOps PR mutation returned unexpected pull request " +
          pullRequest.pullRequestId
      );
    }

    return {
      provider: "azure-devops",
      repository: { id: this.#ctx.repositoryId },
      id: String(pullRequest.pullRequestId),
      number: pullRequest.pullRequestId,
      title: pullRequest.title,
      description: pullRequest.description ?? "",
    };
  }
}

export class AzureDevOpsPullRequestProvider implements PullRequestReviewProvider {
  readonly #ctx: AzureDevOpsContext;
  readonly #client: AzureDevOpsReviewApi;

  constructor(
    ctx: AzureDevOpsContext,
    client: AzureDevOpsReviewApi = new AzureDevOpsClient(ctx)
  ) {
    this.#ctx = ctx;
    this.#client = client;
  }

  async getPullRequest(): Promise<PullRequestSnapshot> {
    const pullRequest = await this.#client.getPullRequest();

    return {
      provider: "azure-devops",
      repository: { id: this.#ctx.repositoryId },
      id: String(pullRequest.pullRequestId),
      number: pullRequest.pullRequestId,
      title: pullRequest.title,
      description: pullRequest.description ?? "",
      source: {
        ref: stripRefsHeads(pullRequest.sourceRefName),
        // The provider snapshot represents the validation invocation, not
        // whatever iteration happens to be live by the time the API responds.
        // Publication performs a separate live-source stale check.
        sha: this.#ctx.sourceCommitId.toLowerCase(),
      },
      target: {
        ref: stripRefsHeads(pullRequest.targetRefName),
      },
    };
  }

  async publishReview(review: ReviewPublication): Promise<ReviewPublicationResult> {
    const publication = await this.#client.upsertReviewThread(
      review.body,
      review.sourceSha
    );

    if (!publication.published) {
      return {
        published: false,
        consistency: "source-convergent",
        supersededBy: publication.supersededBy,
      };
    }

    return {
      published: true,
      created: publication.created,
      id: String(publication.threadId),
      consistency: "source-convergent",
    };
  }
}

export function azureDevOpsValidationEvent(ctx: AzureDevOpsContext): PullRequestEvent {
  return {
    provider: "azure-devops",
    repository: { id: ctx.repositoryId },
    pullRequest: {
      id: String(ctx.pullRequestId),
      number: ctx.pullRequestId,
    },
    sourceSha: ctx.sourceCommitId.toLowerCase(),
    kind: "validation",
  };
}
