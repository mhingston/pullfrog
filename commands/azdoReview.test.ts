import {
  azureInlineFindings,
  azureReviewStatus,
  parseAzureStructuredReview,
  renderAzureReviewMarkdown,
} from "./azdoReview.ts";

describe("parseAzureStructuredReview", () => {
  it("accepts JSON and normalizes inline locations", () => {
    expect(
      parseAzureStructuredReview(
        JSON.stringify({
          summary: "Found a race.",
          findings: [
            {
              severity: "high",
              title: "Race condition",
              body: "The write can win after the guard.",
              path: "/src/review.ts",
              line: 12,
            },
          ],
        })
      )
    ).toEqual({
      summary: "Found a race.",
      findings: [
        {
          severity: "high",
          title: "Race condition",
          body: "The write can win after the guard.",
          path: "src/review.ts",
          line: 12,
        },
      ],
    });
  });

  it("accepts fenced JSON but rejects partial locations", () => {
    expect(
      parseAzureStructuredReview(
        `\`\`\`json
{"summary":"clean","findings":[]}
\`\`\``
      )
    ).toEqual({ summary: "clean", findings: [] });

    expect(() =>
      parseAzureStructuredReview(
        JSON.stringify({
          summary: "bad",
          findings: [
            {
              severity: "medium",
              title: "bad location",
              body: "line is missing",
              path: "src/review.ts",
            },
          ],
        })
      )
    ).toThrow("both path and positive line");
  });
});

describe("azureInlineFindings", () => {
  const diff = [
    "diff --git a/src/review.ts b/src/review.ts",
    "--- a/src/review.ts",
    "+++ b/src/review.ts",
    "@@ -10,3 +10,4 @@",
    " context",
    "-old",
    "+new",
    "+another",
    " tail",
  ].join("\n");

  it("keeps only reliable right-side diff locations", () => {
    const review = parseAzureStructuredReview(
      JSON.stringify({
        summary: "findings",
        findings: [
          {
            severity: "high",
            title: "changed line",
            body: "actionable",
            path: "src/review.ts",
            line: 11,
          },
          {
            severity: "medium",
            title: "outside hunk",
            body: "not reliable",
            path: "src/review.ts",
            line: 99,
          },
          {
            severity: "low",
            title: "general",
            body: "no location",
          },
        ],
      })
    );

    expect(azureInlineFindings(review, diff)).toEqual([
      {
        path: "src/review.ts",
        line: 11,
        body: "**HIGH — changed line**\n\nactionable",
      },
    ]);
  });

  it("deduplicates multiple findings on the same location", () => {
    const review = parseAzureStructuredReview(
      JSON.stringify({
        summary: "findings",
        findings: [
          {
            severity: "high",
            title: "first",
            body: "one",
            path: "src/review.ts",
            line: 11,
          },
          {
            severity: "medium",
            title: "second",
            body: "two",
            path: "src/review.ts",
            line: 11,
          },
        ],
      })
    );

    expect(azureInlineFindings(review, diff)).toHaveLength(1);
  });
});

describe("Azure review status", () => {
  it("fails findings, succeeds clean reviews, and errors partial reviews", () => {
    const clean = { summary: "clean", findings: [] };
    const finding = {
      summary: "issue",
      findings: [
        {
          severity: "high" as const,
          title: "issue",
          body: "details",
        },
      ],
    };

    expect(azureReviewStatus(clean, { truncatedDiff: false }).state).toBe("succeeded");
    expect(azureReviewStatus(finding, { truncatedDiff: false }).state).toBe("failed");
    expect(azureReviewStatus(clean, { truncatedDiff: true }).state).toBe("error");
  });

  it("renders partial reviews with an unconditional warning", () => {
    const markdown = renderAzureReviewMarkdown(
      { summary: "partial", findings: [] },
      { truncatedDiff: true }
    );
    expect(markdown).toContain("Partial review");
    expect(markdown).toContain("merge-gating status is an error");
  });
});
