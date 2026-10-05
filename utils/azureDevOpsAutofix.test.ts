import {
  azureMergeStatusNeedsRepair,
  buildAzureCiRepairPrompt,
  buildAzureConflictRepairPrompt,
  parseAzureRepairMaxAttempts,
  resolveAzureCiAutofixSettings,
  selectAzureCiRepairEligibility,
} from "./azureDevOpsAutofix.ts";
import type { AzureCiFailureContext } from "./azureDevOpsBuild.ts";

describe("Azure CI autofix settings", () => {
  it("defaults both PR classes off and repair attempts to three", () => {
    expect(resolveAzureCiAutofixSettings({})).toEqual({
      ownPrs: false,
      reviewedPrs: false,
      maxAttempts: 3,
    });
  });

  it("parses explicit opt-in toggles", () => {
    expect(
      resolveAzureCiAutofixSettings({
        PULLFROG_AZDO_FIX_CI_OWN_PRS: "enabled",
        PULLFROG_AZDO_FIX_CI_REVIEWED_PRS: "true",
        PULLFROG_AZDO_MAX_REPAIR_ATTEMPTS: "5",
      })
    ).toEqual({
      ownPrs: true,
      reviewedPrs: true,
      maxAttempts: 5,
    });
  });

  it("rejects unbounded repair attempt configuration", () => {
    expect(() => parseAzureRepairMaxAttempts("0")).toThrow("between 1 and 10");
    expect(() => parseAzureRepairMaxAttempts("11")).toThrow("between 1 and 10");
    expect(() => parseAzureRepairMaxAttempts("many")).toThrow("between 1 and 10");
  });
});

describe("Azure CI autofix eligibility", () => {
  const bothEnabled = {
    ownPrs: true,
    reviewedPrs: true,
    maxAttempts: 3,
  };

  it("uses the separate own-PR toggle for Pullfrog-owned PRs", () => {
    expect(
      selectAzureCiRepairEligibility({
        pullfrogOwned: true,
        reviewedAtSource: false,
        settings: bothEnabled,
      })
    ).toEqual({ eligible: true, class: "own" });

    expect(
      selectAzureCiRepairEligibility({
        pullfrogOwned: true,
        reviewedAtSource: true,
        settings: { ...bothEnabled, ownPrs: false },
      })
    ).toEqual({ eligible: false, reason: "own-pr-fixes-disabled" });
  });

  it("requires both an exact-source Pullfrog review and the reviewed-PR toggle for human PRs", () => {
    expect(
      selectAzureCiRepairEligibility({
        pullfrogOwned: false,
        reviewedAtSource: false,
        settings: bothEnabled,
      })
    ).toEqual({ eligible: false, reason: "not-pullfrog-reviewed" });

    expect(
      selectAzureCiRepairEligibility({
        pullfrogOwned: false,
        reviewedAtSource: true,
        settings: { ...bothEnabled, reviewedPrs: false },
      })
    ).toEqual({ eligible: false, reason: "reviewed-pr-fixes-disabled" });

    expect(
      selectAzureCiRepairEligibility({
        pullfrogOwned: false,
        reviewedAtSource: true,
        settings: bothEnabled,
      })
    ).toEqual({ eligible: true, class: "reviewed" });
  });
});

describe("Azure merge-conflict detection", () => {
  it.each(["conflicts", "Conflicts", "failure", "Failure"])(
    "treats %s as requiring repair",
    (status) => {
      expect(azureMergeStatusNeedsRepair(status)).toBe(true);
    }
  );

  it.each([undefined, "succeeded", "queued", "rejectedByPolicy"])(
    "does not treat %s as a supported conflict state",
    (status) => {
      expect(azureMergeStatusNeedsRepair(status)).toBe(false);
    }
  );
});

describe("Azure repair prompts", () => {
  const failure: AzureCiFailureContext = {
    build: { id: 10, result: "failed" },
    failedLogs: [
      {
        recordId: "task-1",
        recordName: "tests",
        recordType: "Task",
        logId: 7,
        result: "failed",
        issues: ["Tests failed"],
        totalLines: 5,
        truncated: false,
        index: [
          { line: 4, type: "error", content: "Assertion failed" },
        ],
        excerpt: "    4 | ##[error] Assertion failed",
      },
    ],
    truncated: false,
  };

  it("treats CI logs as untrusted and keeps commit/push ownership with Pullfrog", () => {
    const prompt = buildAzureCiRepairPrompt({
      pullRequestId: 42,
      sourceBranch: "feature/fix",
      targetBranch: "main",
      sourceSha: "0".repeat(40),
      attempt: 2,
      failure,
      additionalInstructions: "Run the targeted tests first.",
    });

    expect(prompt).toContain("UNTRUSTED build output");
    expect(prompt).toContain("Do not commit, push");
    expect(prompt).toContain("Pullfrog owns");
    expect(prompt).toContain("Assertion failed");
    expect(prompt).toContain("Repair attempt: 2");
    expect(prompt).toContain("Run the targeted tests first.");
  });

  it("constrains conflict repair to editing the prepared merge working tree", () => {
    const prompt = buildAzureConflictRepairPrompt({
      pullRequestId: 42,
      sourceBranch: "feature/fix",
      targetBranch: "main",
      sourceSha: "0".repeat(40),
      targetSha: "1".repeat(40),
      attempt: 1,
      conflictedFiles: ["src/a.ts", "src/b.ts"],
    });

    expect(prompt).toContain("git merge --no-commit --no-ff");
    expect(prompt).toContain("Do not abort/restart the merge, commit, push");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("MERGE_HEAD");
  });
});
