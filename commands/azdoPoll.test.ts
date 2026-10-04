import {
  parseAzureAllowedActorIds,
  parseAzurePollAfter,
  selectAzurePollingCandidates,
} from "./azdoPoll.ts";
import { azureDevOpsReviewMarker } from "../utils/azureDevOps.ts";

const source = "0123456789abcdef0123456789abcdef01234567";

describe("Azure follow-up poll configuration", () => {
  it("requires an explicit immutable actor-id allowlist", () => {
    expect(() => parseAzureAllowedActorIds(undefined)).toThrow(
      "requires at least one allowed actor id"
    );
    expect(parseAzureAllowedActorIds(" A-ID, b-id ,A-ID ")).toEqual(
      new Set(["a-id", "b-id"])
    );
  });

  it("requires a valid rollout cutoff", () => {
    expect(() => parseAzurePollAfter(undefined)).toThrow("requires --after");
    expect(() => parseAzurePollAfter("not-a-date")).toThrow("invalid");
    expect(parseAzurePollAfter("2026-10-04T18:00:00Z").toISOString()).toBe(
      "2026-10-04T18:00:00.000Z"
    );
  });
});

describe("Azure follow-up poll candidate selection", () => {
  const after = new Date("2026-10-04T18:00:00Z");
  const allowed = new Set(["actor-1"]);

  it("selects an allowed explicit mention after the rollout cutoff", () => {
    expect(
      selectAzurePollingCandidates({
        pullRequestId: 42,
        allowedActorIds: allowed,
        after,
        threads: [
          {
            id: 17,
            comments: [
              {
                id: 4,
                parentCommentId: 0,
                content: "@pullfrog explain this",
                commentType: "text",
                publishedDate: "2026-10-04T18:01:00Z",
                author: { id: "ACTOR-1", displayName: "Mark" },
              },
            ],
          },
        ],
      })
    ).toEqual([
      {
        pullRequestId: 42,
        threadId: 17,
        commentId: 4,
        actorId: "actor-1",
        publishedAt: "2026-10-04T18:01:00.000Z",
      },
    ]);
  });

  it("ignores unauthorized, old, undated, and already handled comments", () => {
    expect(
      selectAzurePollingCandidates({
        pullRequestId: 42,
        allowedActorIds: allowed,
        after,
        threads: [
          {
            id: 10,
            comments: [
              {
                id: 1,
                content: "@pullfrog unauthorized",
                publishedDate: "2026-10-04T18:05:00Z",
                author: { id: "actor-2" },
              },
            ],
          },
          {
            id: 11,
            comments: [
              {
                id: 2,
                content: "@pullfrog old",
                publishedDate: "2026-10-04T17:59:59Z",
                author: { id: "actor-1" },
              },
            ],
          },
          {
            id: 12,
            comments: [
              {
                id: 3,
                content: "@pullfrog no timestamp",
                author: { id: "actor-1" },
              },
            ],
          },
          {
            id: 13,
            comments: [
              {
                id: 4,
                content: "@pullfrog already done",
                publishedDate: "2026-10-04T18:05:00Z",
                author: { id: "actor-1" },
              },
              {
                id: 5,
                content:
                  "answer\n\n<!-- pullfrog-azure-devops-followup:13:4 -->",
              },
            ],
          },
        ],
      })
    ).toEqual([]);
  });

  it("selects an allowed reply in a Pullfrog-owned thread without a mention", () => {
    expect(
      selectAzurePollingCandidates({
        pullRequestId: 42,
        allowedActorIds: allowed,
        after,
        threads: [
          {
            id: 17,
            comments: [
              {
                id: 1,
                content: "review\n\n" + azureDevOpsReviewMarker(source),
                publishedDate: "2026-10-04T17:00:00Z",
              },
              {
                id: 2,
                parentCommentId: 1,
                content: "What is the smallest fix?",
                commentType: 1,
                publishedDate: "2026-10-04T18:05:00Z",
                author: { id: "actor-1" },
              },
            ],
          },
        ],
      })
    ).toHaveLength(1);
  });

  it("orders oldest first and applies the global candidate cap", () => {
    const threads = [1, 2, 3].map((id) => ({
      id,
      comments: [
        {
          id,
          content: "@pullfrog q" + id,
          publishedDate: "2026-10-04T18:0" + (4 - id) + ":00Z",
          author: { id: "actor-1" },
        },
      ],
    }));

    expect(
      selectAzurePollingCandidates({
        pullRequestId: 42,
        allowedActorIds: allowed,
        after,
        threads,
        max: 2,
      }).map((candidate) => candidate.threadId)
    ).toEqual([3, 2]);
  });
});
