import {
  AzureDevOpsPullRequestProvider,
  azureDevOpsValidationEvent,
  type AzureDevOpsReviewApi,
} from "./azureDevOps.ts";
import {
  GitHubPullRequestProvider,
  type GitHubReviewApi,
} from "./github.ts";
import { runPullRequestReview } from "./review.ts";
import type { PullRequestReviewProvider } from "./types.ts";
import type { AzureDevOpsContext } from "../utils/azureDevOps.ts";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const newerSha = "fedcba9876543210fedcba9876543210fedcba98";

function azureFixture(): {
  provider: PullRequestReviewProvider;
  published: Array<{ body: string; sourceSha: string }>;
} {
  const ctx: AzureDevOpsContext = {
    collectionUri: "https://dev.azure.com/acme/",
    project: "Platform",
    repositoryId: "repo-guid",
    pullRequestId: 42,
    sourceBranch: "feature/provider",
    sourceCommitId: sourceSha,
    targetBranch: "main",
    authorization: "Bearer test",
  };
  const published: Array<{ body: string; sourceSha: string }> = [];
  const client: AzureDevOpsReviewApi = {
    async getPullRequest() {
      return {
        pullRequestId: 42,
        title: "provider boundary",
        description: "shared review contract",
        sourceRefName: "refs/heads/feature/provider",
        targetRefName: "refs/heads/main",
      };
    },
    async upsertReviewThread(body, expectedSourceSha) {
      published.push({ body, sourceSha: expectedSourceSha });
      return { published: true, created: false, threadId: 17 };
    },
  };
  return {
    provider: new AzureDevOpsPullRequestProvider(ctx, client),
    published,
  };
}

function githubFixture(): {
  provider: PullRequestReviewProvider;
  published: Array<{ body: string; sourceSha: string }>;
} {
  const published: Array<{ body: string; sourceSha: string }> = [];
  const api: GitHubReviewApi = {
    pulls: {
      async get() {
        return {
          data: {
            id: 9001,
            number: 42,
            title: "provider boundary",
            body: "shared review contract",
            head: { ref: "feature/provider", sha: sourceSha },
            base: { ref: "main" },
          },
        };
      },
      async createReview(params) {
        published.push({ body: params.body, sourceSha: params.commit_id });
        return { data: { id: 23 } };
      },
    },
  };
  return {
    provider: new GitHubPullRequestProvider({
      api,
      owner: "acme",
      repo: "widget",
      pullNumber: 42,
    }),
    published,
  };
}

const providerFixtures: Array<[
  string,
  () => {
    provider: PullRequestReviewProvider;
    published: Array<{ body: string; sourceSha: string }>;
  },
]> = [
  ["Azure DevOps", azureFixture],
  ["GitHub", githubFixture],
];

describe.each(providerFixtures)("%s provider contract", (_name, fixture) => {
  it("normalizes PR identity and publishes against the reviewed source SHA", async () => {
    const { provider, published } = fixture();
    const result = await runPullRequestReview({
      provider,
      review: async (pullRequest) => {
        expect(pullRequest.number).toBe(42);
        expect(pullRequest.title).toBe("provider boundary");
        expect(pullRequest.source).toEqual({
          ref: "feature/provider",
          sha: sourceSha,
        });
        expect(pullRequest.target).toEqual({ ref: "main" });
        return "review body";
      },
    });

    expect(result.publication?.published).toBe(true);
    expect(published).toEqual([{ body: "review body", sourceSha }]);
  });

  it("supports dry-run orchestration without invoking publication", async () => {
    const { provider, published } = fixture();
    const result = await runPullRequestReview({
      provider,
      dryRun: true,
      review: async () => "dry review",
    });

    expect(result.body).toBe("dry review");
    expect(result.publication).toBeUndefined();
    expect(published).toHaveLength(0);
  });
});

describe("provider-specific stale publication", () => {
  it("normalizes Azure stale publication", async () => {
    const ctx: AzureDevOpsContext = {
      collectionUri: "https://dev.azure.com/acme/",
      project: "Platform",
      repositoryId: "repo-guid",
      pullRequestId: 42,
      sourceBranch: "feature/provider",
      sourceCommitId: sourceSha,
      targetBranch: "main",
      authorization: "Bearer test",
    };
    const client: AzureDevOpsReviewApi = {
      async getPullRequest() {
        return {
          pullRequestId: 42,
          title: "provider boundary",
          sourceRefName: "refs/heads/feature/provider",
          targetRefName: "refs/heads/main",
        };
      },
      async upsertReviewThread() {
        return { published: false, supersededBy: newerSha };
      },
    };

    const provider = new AzureDevOpsPullRequestProvider(ctx, client);
    await expect(
      provider.publishReview({ body: "old", sourceSha })
    ).resolves.toEqual({
      published: false,
      supersededBy: newerSha,
    });
  });

  it("suppresses a GitHub review when the live head moved", async () => {
    let currentSha = sourceSha;
    const createReview = vi.fn(async () => ({ data: { id: 23 } }));
    const api: GitHubReviewApi = {
      pulls: {
        async get() {
          return {
            data: {
              id: 9001,
              number: 42,
              title: "provider boundary",
              body: "",
              head: { ref: "feature/provider", sha: currentSha },
              base: { ref: "main" },
            },
          };
        },
        createReview,
      },
    };
    const provider = new GitHubPullRequestProvider({
      api,
      owner: "acme",
      repo: "widget",
      pullNumber: 42,
    });

    currentSha = newerSha;
    await expect(
      provider.publishReview({ body: "old", sourceSha })
    ).resolves.toEqual({
      published: false,
      supersededBy: newerSha,
    });
    expect(createReview).not.toHaveBeenCalled();
  });
});

describe("Azure Pipelines event adapter", () => {
  it("normalizes build validation into the provider-neutral event envelope", () => {
    const ctx: AzureDevOpsContext = {
      collectionUri: "https://dev.azure.com/acme/",
      project: "Platform",
      repositoryId: "repo-guid",
      pullRequestId: 42,
      sourceBranch: "feature/provider",
      sourceCommitId: sourceSha.toUpperCase(),
      targetBranch: "main",
      authorization: "Bearer test",
    };

    expect(azureDevOpsValidationEvent(ctx)).toEqual({
      provider: "azure-devops",
      repository: { id: "repo-guid" },
      pullRequest: { id: "42", number: 42 },
      sourceSha,
      kind: "validation",
    });
  });
});
