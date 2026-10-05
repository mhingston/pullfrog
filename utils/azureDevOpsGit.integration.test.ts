import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AzureDevOpsRepositoryClient,
  resolveAzureDevOpsRepositoryContext,
} from "./azureDevOps.ts";
import {
  commitAndPushAzureDevOpsPullfrogBranch,
  prepareAzureDevOpsPullfrogBranchCheckout,
} from "./azureDevOpsGit.ts";

const integrationEnabled = process.env.PULLFROG_AZDO_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

describeIntegration("Azure DevOps authenticated git integration", () => {
  it(
    "creates, fetches, CAS-pushes, verifies, and deletes a disposable Pullfrog branch",
    async () => {
      const repository = resolveAzureDevOpsRepositoryContext();
      const confirmedRepositoryId =
        process.env.PULLFROG_AZDO_INTEGRATION_REPOSITORY_ID?.trim();
      if (!confirmedRepositoryId) {
        throw new Error(
          "PULLFROG_AZDO_INTEGRATION_REPOSITORY_ID is required for the destructive Azure integration test"
        );
      }
      if (
        confirmedRepositoryId.toLowerCase() !==
        repository.repositoryId.toLowerCase()
      ) {
        throw new Error(
          "refusing Azure integration test: confirmed repository ID does not match BUILD_REPOSITORY_ID"
        );
      }

      const suffix = (
        process.env.PULLFROG_AZDO_INTEGRATION_BRANCH_SUFFIX?.trim() ||
        process.env.BUILD_BUILDID?.trim() ||
        String(Date.now())
      ).replace(/[^A-Za-z0-9._-]/g, "-");
      const branch = "pullfrog/branches/integration-" + suffix;
      const targetBranch = repository.defaultBranch;
      const client = new AzureDevOpsRepositoryClient(repository);
      const root = mkdtempSync(join(tmpdir(), "pullfrog-azdo-integration-"));
      let cleanupSha: string | undefined;
      let branchCreated = false;

      try {
        git(root, ["init"]);
        git(root, ["remote", "add", "origin", repository.repositoryUri]);

        const created = await client.createPullfrogBranch({
          branch,
          targetBranch,
          permission: "enabled",
        });
        cleanupSha = created.sha;
        branchCreated = true;

        const ctx = {
          ...repository,
          sourceBranch: branch,
          sourceCommitId: created.sha,
          targetBranch,
        };
        const prepared = prepareAzureDevOpsPullfrogBranchCheckout({
          cwd: root,
          ctx,
          permission: "enabled",
        });
        expect(prepared).toEqual({ branch, sha: created.sha });

        writeFileSync(
          join(root, "pullfrog-azure-integration.txt"),
          "Pullfrog Azure integration " + suffix + "\n"
        );

        const result = await commitAndPushAzureDevOpsPullfrogBranch({
          cwd: root,
          ctx,
          permission: "enabled",
          message: "test: Azure authenticated fetch/push " + suffix,
          getLiveSourceCommitId: () => client.getBranchObjectId(branch),
          verifyOwnership: (candidate) =>
            client.hasPullfrogBranchOwnership(candidate),
        });
        cleanupSha = result.pushedSha;

        await expect(client.getBranchObjectId(branch)).resolves.toBe(
          result.pushedSha
        );
      } finally {
        try {
          if (branchCreated && cleanupSha) {
            await client.deletePullfrogBranch({
              branch,
              expectedCommitId: cleanupSha,
              permission: "enabled",
            });
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }

      expect(cleanupSha).toMatch(/^[0-9a-f]{40}$/);
      await expect(client.getBranchObjectId(branch)).resolves.toBeUndefined();
    },
    120_000
  );
});
