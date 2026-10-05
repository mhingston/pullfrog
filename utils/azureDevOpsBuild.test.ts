import {
  analyzeAzurePipelineLog,
  AzureDevOpsBuildClient,
  buildMatchesPullRequestSource,
  redactAzurePipelineLog,
  type AzureDevOpsBuild,
} from "./azureDevOpsBuild.ts";
import type { AzureDevOpsRepositoryContext } from "./azureDevOps.ts";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";

function context(): AzureDevOpsRepositoryContext {
  return {
    collectionUri: "https://dev.azure.com/acme/",
    project: "Platform",
    repositoryId: "repo-guid",
    repositoryUri: "https://dev.azure.com/acme/Platform/_git/widget",
    defaultBranch: "main",
    authorization: "Bearer job-token",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Azure Pipeline build matching", () => {
  it("matches immutable PR number and source SHA from triggerInfo", () => {
    const build: AzureDevOpsBuild = {
      id: 10,
      sourceVersion: "f".repeat(40),
      triggerInfo: {
        "pr.number": "42",
        "pr.sourceSha": sourceSha.toUpperCase(),
      },
    };
    expect(
      buildMatchesPullRequestSource({
        build,
        pullRequestId: 42,
        sourceSha,
      })
    ).toBe(true);
    expect(
      buildMatchesPullRequestSource({
        build,
        pullRequestId: 43,
        sourceSha,
      })
    ).toBe(false);
  });

  it("matches Azure Repos PR metadata from the serialized build parameters fallback", () => {
    const build: AzureDevOpsBuild = {
      id: 10,
      sourceBranch: "refs/pull/42/merge",
      sourceVersion: "a".repeat(40),
      triggerInfo: { "pr.number": "42", "pr.isFork": "False" },
      parameters: JSON.stringify({
        "system.pullRequest.pullRequestId": "42",
        "system.pullRequest.sourceCommitId": sourceSha,
      }),
    };

    expect(
      buildMatchesPullRequestSource({
        build,
        pullRequestId: 42,
        sourceSha,
        mergeSha: "a".repeat(40),
      })
    ).toBe(true);
  });

  it("requires an explicit/derivable PR number even when the source SHA matches", () => {
    expect(
      buildMatchesPullRequestSource({
        build: {
          id: 10,
          sourceVersion: sourceSha,
        },
        pullRequestId: 42,
        sourceSha,
      })
    ).toBe(false);
  });

  it("does not infer a PR/source match from branch names", () => {
    expect(
      buildMatchesPullRequestSource({
        build: {
          id: 10,
          sourceBranch: "refs/pull/42/merge",
          sourceVersion: "f".repeat(40),
        },
        pullRequestId: 42,
        sourceSha,
      })
    ).toBe(false);
  });
});

describe("Azure Pipeline log redaction", () => {
  it("redacts exact secrets, auth headers, secret logging commands, and URL credentials", () => {
    const raw = [
      "token=super-secret-value",
      "Authorization: Bearer abc.def.ghi",
      "SYSTEM_ACCESSTOKEN=raw-job-token",
      "##vso[task.setvariable variable=X;issecret=true]hidden-value",
      "https://user:password@example.invalid/path",
    ].join("\n");

    const redacted = redactAzurePipelineLog(raw, ["super-secret-value"]);

    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("raw-job-token");
    expect(redacted).not.toContain("hidden-value");
    expect(redacted).not.toContain("user:password@");
    expect(redacted).toContain("[REDACTED]");
  });

  it("returns a bounded error index and excerpt", () => {
    const analysis = analyzeAzurePipelineLog(
      [
        "setup",
        "running tests",
        "##[error] Assertion failed",
        "    at test.ts:10:2",
        "Process completed with exit code 1",
      ].join("\n")
    );

    expect(analysis.index.map((entry) => entry.type)).toEqual([
      "error",
      "trace",
      "error",
    ]);
    expect(analysis.excerpt).toContain("Assertion failed");
    expect(analysis.excerpt).toContain("exit code 1");
  });

  it("finds tail failures beyond the excerpt limit and preserves original line numbers", () => {
    const raw = [
      ...Array.from({ length: 300 }, (_, index) => "routine output " + index),
      "##[error] failure only at the end",
    ].join("\n");

    const analysis = analyzeAzurePipelineLog(raw, { maxChars: 300 });
    expect(analysis.truncated).toBe(true);
    expect(analysis.index.at(-1)).toMatchObject({
      line: 301,
      type: "error",
      content: "##[error] failure only at the end",
    });
    expect(analysis.excerpt).toContain("failure only at the end");
    expect(analysis.excerpt.length).toBeLessThanOrEqual(300);
  });
});

describe("AzureDevOpsBuildClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers only builds belonging to the requested PR/source revision", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/_apis/build/builds?");
      expect(url).toContain("reasonFilter=pullRequest");
      return jsonResponse({
        value: [
          {
            id: 10,
            triggerInfo: {
              "pr.number": "42",
              "pr.sourceSha": sourceSha,
            },
          },
          {
            id: 11,
            triggerInfo: {
              "pr.number": "42",
              "pr.sourceSha": "f".repeat(40),
            },
          },
          {
            id: 12,
            triggerInfo: {
              "pr.number": "43",
              "pr.sourceSha": sourceSha,
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    await expect(
      client.listPullRequestBuilds({
        pullRequestId: 42,
        sourceSha,
      })
    ).resolves.toEqual([
      {
        id: 10,
        triggerInfo: {
          "pr.number": "42",
          "pr.sourceSha": sourceSha,
        },
      },
    ]);
  });

  it("collects only failed timeline logs and redacts credentials before returning context", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/builds/10?api-version=7.1")) {
        return jsonResponse({
          id: 10,
          result: "failed",
          triggerInfo: {
            "pr.number": "42",
            "pr.sourceSha": sourceSha,
          },
        });
      }
      if (url.endsWith("/builds/10/timeline?api-version=7.1")) {
        return jsonResponse({
          records: [
            {
              id: "job-ok",
              type: "Job",
              name: "passing",
              result: "succeeded",
              log: { id: 1 },
              order: 1,
            },
            {
              id: "job-failed",
              type: "Job",
              name: "test",
              result: "failed",
              log: { id: 2 },
              order: 2,
              issues: [{ message: "Authorization: Bearer leak-me" }],
            },
            {
              id: "task-same-log",
              type: "Task",
              name: "nested",
              result: "failed",
              log: { id: 2 },
              order: 3,
            },
          ],
        });
      }
      if (url.endsWith("/builds/10/logs/2?api-version=7.1")) {
        return new Response(
          "starting\nSYSTEM_ACCESSTOKEN=job-token\n##[error] tests failed\n",
          { status: 200, headers: { "content-type": "text/plain" } }
        );
      }
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    const result = await client.collectFailureContext({
      buildId: 10,
      pullRequestId: 42,
      sourceSha,
      secrets: ["job-token", "leak-me"],
    });

    expect(result.failedLogs).toHaveLength(1);
    expect(result.failedLogs[0]?.recordName).toBe("test");
    expect(result.failedLogs[0]?.excerpt).toContain("[REDACTED]");
    expect(result.failedLogs[0]?.excerpt).not.toContain("job-token");
    expect(result.failedLogs[0]?.issues.join("\n")).not.toContain("leak-me");
  });

  it("collects succeeded-with-issues timeline diagnostics for partially succeeded builds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/builds/10?api-version=7.1")) {
        return jsonResponse({
          id: 10,
          result: "partiallySucceeded",
          triggerInfo: {
            "pr.number": "42",
            "pr.sourceSha": sourceSha,
          },
        });
      }
      if (url.endsWith("/builds/10/timeline?api-version=7.1")) {
        return jsonResponse({
          records: [
            {
              id: "task-warning",
              type: "Task",
              name: "lint",
              result: "succeededWithIssues",
              log: { id: 3 },
              order: 1,
              issues: [{ message: "lint warning promoted to partial success" }],
            },
          ],
        });
      }
      if (url.endsWith("/builds/10/logs/3?api-version=7.1")) {
        return new Response("##[warning] lint warning\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    const result = await client.collectFailureContext({
      buildId: 10,
      pullRequestId: 42,
      sourceSha,
    });

    expect(result.failedLogs).toHaveLength(1);
    expect(result.failedLogs[0]?.recordName).toBe("lint");
    expect(result.failedLogs[0]?.result).toBe("succeededWithIssues");
  });

  it("refuses failure logs for a different PR/source revision", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 10,
        result: "failed",
        triggerInfo: {
          "pr.number": "42",
          "pr.sourceSha": "f".repeat(40),
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    await expect(
      client.collectFailureContext({
        buildId: 10,
        pullRequestId: 42,
        sourceSha,
      })
    ).rejects.toThrow("does not belong to the expected PR/source revision");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to requeue a successful validation build", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 10,
        result: "succeeded",
        definition: { id: 7 },
        sourceBranch: "refs/pull/42/merge",
        sourceVersion: "a".repeat(40),
        triggerInfo: {
          "pr.number": "42",
          "pr.sourceSha": sourceSha,
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    await expect(
      client.requeueBuild({
        buildId: 10,
        pullRequestId: 42,
        sourceSha,
      })
    ).rejects.toThrow("failed or partially succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requeues only the exact expected PR/source build", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/builds/10?api-version=7.1")) {
        return jsonResponse({
          id: 10,
          result: "failed",
          definition: { id: 7 },
          sourceBranch: "refs/pull/42/merge",
          sourceVersion: "a".repeat(40),
          triggerInfo: {
            "pr.number": "42",
            "pr.sourceSha": sourceSha,
          },
          parameters: "{\"configuration\":\"ci\"}",
        });
      }
      if (url.endsWith("/builds?api-version=7.1") && method === "POST") {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: 11, status: "notStarted" });
      }
      throw new Error("unexpected request: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    await expect(
      client.requeueBuild({
        buildId: 10,
        pullRequestId: 42,
        sourceSha,
      })
    ).resolves.toMatchObject({ id: 11 });

    expect(bodies).toEqual([
      {
        definition: { id: 7 },
        sourceBranch: "refs/pull/42/merge",
        sourceVersion: "a".repeat(40),
        parameters: "{\"configuration\":\"ci\"}",
      },
    ]);
  });
});


describe("AzureDevOpsBuildClient in-progress validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects already-failed timeline diagnostics from the current in-progress validation build", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/builds/10?api-version=7.1")) {
        return jsonResponse({
          id: 10,
          status: "inProgress",
          triggerInfo: {
            "pr.number": "42",
            "pr.sourceSha": sourceSha,
          },
        });
      }
      if (url.endsWith("/builds/10/timeline?api-version=7.1")) {
        return jsonResponse({
          records: [
            {
              id: "task-failed",
              type: "Task",
              name: "tests",
              result: "failed",
              log: { id: 9 },
            },
          ],
        });
      }
      if (url.endsWith("/builds/10/logs/9?api-version=7.1")) {
        return new Response("##[error] tests failed\n", { status: 200 });
      }
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsBuildClient(context());
    await expect(
      client.collectFailureContext({
        buildId: 10,
        pullRequestId: 42,
        sourceSha,
      })
    ).resolves.toMatchObject({
      build: { id: 10, status: "inProgress" },
      failedLogs: [{ recordName: "tests" }],
    });
  });
});
