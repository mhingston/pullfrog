import { selectAzureFollowUp } from "./azdoFollowUp.ts";
import {
  azureDevOpsFindingMarker,
  azureDevOpsReviewMarker,
  type AzureDevOpsThread,
} from "../utils/azureDevOps.ts";

const source = "0123456789abcdef0123456789abcdef01234567";

function thread(comments: AzureDevOpsThread["comments"]): AzureDevOpsThread {
  return { id: 17, status: 1, comments };
}

describe("Azure follow-up selection", () => {
  it("triggers an explicit @pullfrog request in a user-owned thread", () => {
    const result = selectAzureFollowUp({
      thread: thread([
        {
          id: 1,
          parentCommentId: 0,
          content: "@pullfrog can you explain why this is risky?",
          author: { displayName: "Mark" },
        },
      ]),
      commentId: 1,
    });

    expect(result).toMatchObject({
      kind: "trigger",
      trigger: {
        threadId: 17,
        commentId: 1,
        author: "Mark",
        pullfrogOwnedThread: false,
      },
    });
  });

  it("triggers a reply without a mention when Pullfrog owns the thread", () => {
    const result = selectAzureFollowUp({
      thread: thread([
        {
          id: 1,
          parentCommentId: 0,
          content: "review\n\n" + azureDevOpsReviewMarker(source),
          author: { displayName: "Pullfrog" },
        },
        {
          id: 2,
          parentCommentId: 1,
          content: "What would the smallest fix look like?",
          author: { displayName: "Mark" },
        },
      ]),
      commentId: 2,
    });

    expect(result).toMatchObject({
      kind: "trigger",
      trigger: {
        commentId: 2,
        pullfrogOwnedThread: true,
      },
    });
  });

  it("also treats an inline finding as a Pullfrog-owned thread", () => {
    const result = selectAzureFollowUp({
      thread: thread([
        {
          id: 1,
          content:
            "finding\n\n" + azureDevOpsFindingMarker(source, "src/a.ts", 12),
        },
        {
          id: 2,
          parentCommentId: 1,
          content: "Why does this race?",
        },
      ]),
      commentId: 2,
    });

    expect(result.kind).toBe("trigger");
  });

  it("ignores an unrelated new human thread", () => {
    expect(
      selectAzureFollowUp({
        thread: thread([{ id: 1, content: "Looks good to me" }]),
        commentId: 1,
      })
    ).toEqual({
      kind: "ignored",
      reason:
        "comment must mention @pullfrog unless it is a reply in a Pullfrog-owned thread",
    });
  });

  it("does not trigger from Pullfrog's own comments", () => {
    expect(
      selectAzureFollowUp({
        thread: thread([
          {
            id: 1,
            content: "review\n\n" + azureDevOpsReviewMarker(source),
          },
        ]),
        commentId: 1,
      })
    ).toEqual({
      kind: "ignored",
      reason: "Pullfrog does not trigger from its own comments",
    });
  });

  it("recognizes an already handled trigger marker", () => {
    expect(
      selectAzureFollowUp({
        thread: thread([
          { id: 4, content: "@pullfrog explain this" },
          {
            id: 5,
            parentCommentId: 4,
            content:
              "answer\n\n<!-- pullfrog-azure-devops-followup:17:4 -->",
          },
        ]),
        commentId: 4,
      })
    ).toEqual({ kind: "already-handled", commentId: 5 });
  });
});
