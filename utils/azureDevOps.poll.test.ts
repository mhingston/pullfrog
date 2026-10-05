import {
  AzureDevOpsRepositoryClient,
  resolveAzureDevOpsRepositoryContext,
} from "./azureDevOps.ts";

const env = {
  SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme",
  SYSTEM_TEAMPROJECT: "Platform",
  BUILD_REPOSITORY_ID: "repo-guid",
  BUILD_REPOSITORY_URI: "https://dev.azure.com/acme/Platform/_git/widget",
  BUILD_REPOSITORY_DEFAULTBRANCH: "refs/heads/main",
  BUILD_REPOSITORY_PROVIDER: "TfsGit",
  SYSTEM_ACCESSTOKEN: "job-token",
} satisfies NodeJS.ProcessEnv;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AzureDevOpsRepositoryClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists active pull requests with bounded pagination", async () => {
    const calls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      pullRequestId: index + 1,
      title: "PR " + (index + 1),
      sourceRefName: "refs/heads/feature/" + (index + 1),
      targetRefName: "refs/heads/main",
    }));
    const page2 = Array.from({ length: 20 }, (_, index) => ({
      pullRequestId: index + 101,
      title: "PR " + (index + 101),
      sourceRefName: "refs/heads/feature/" + (index + 101),
      targetRefName: "refs/heads/main",
    }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("$skip=0") && url.includes("$top=100")) {
        return jsonResponse({ count: page1.length, value: page1 });
      }
      if (url.includes("$skip=100") && url.includes("$top=50")) {
        return jsonResponse({ count: page2.length, value: page2 });
      }
      throw new Error("unexpected request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    const results = await client.listActivePullRequests({ max: 150 });

    expect(results).toHaveLength(120);
    expect(results[0]?.pullRequestId).toBe(1);
    expect(results[results.length - 1]?.pullRequestId).toBe(120);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("searchCriteria.status=active");
  });

  it("rejects unbounded scans", async () => {
    const client = new AzureDevOpsRepositoryClient(
      resolveAzureDevOpsRepositoryContext(env)
    );
    await expect(client.listActivePullRequests({ max: 1001 })).rejects.toThrow(
      "between 1 and 1000"
    );
  });
});
