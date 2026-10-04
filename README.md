<p align="center">
  <h1 align="center">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/frog-white-200px.png">
      <img src="https://pullfrog.com/frog-green-200px.png" width="25px" align="center" alt="Green Pullfrog logo" />
    </picture><br />
    Pullfrog
  </h1>
  <p align="center">
    The BYOK CodeRabbit that runs in your GitHub Actions
  </p>
</p>

<p align="center">
  <a href="https://pullfrog.com">pullfrog.com</a> · <a href="https://docs.pullfrog.com">Docs</a> · <a href="https://pullfrog.com/console">Console</a> · <a href="https://discord.gg/8y96raFg8e">Discord</a>
</p>

<br/>

> **New** — Pullfrog is now [free for personal and open-source usage](https://pullfrog.com/blog/free-for-open-source).

## What is Pullfrog?

Pullfrog is the BYOK CodeRabbit that runs in your GitHub Actions. It listens for GitHub events — PRs opened, issues created, reviews submitted, CI failures — and triggers agent runs based on your configuration, via a `pullfrog.yml` workflow that uses this open-source action. You control the infrastructure, the keys, and the costs.

Pullfrog is not an agent itself. It wraps vanilla **[Claude Code](https://github.com/anthropics/claude-code)**, **[Codex](https://github.com/openai/codex)**, and **[OpenCode](https://github.com/anomalyco/opencode)**, selecting the one that matches your BYOK or bring-your-own-subscription configuration — so every run uses the vendor's real agent, and it reads the repo-level config you already keep for it: `CLAUDE.md` or `AGENTS.md`, skills, custom commands, and repo-level MCP servers.

Out of the box, it can:

- **Review new PRs** — auto-review every incoming PR; the review verdict can gate merges via requireable status checks.
- **Address reviews** — leave review comments on a Pullfrog PR as you would for a human colleague, and it addresses them.
- **Autofix CI** — Pullfrog detects CI failures on its own PRs and attempts a fix. It can be configured to fix human PRs too.
- **Autofix merge conflicts** — keep PRs mergeable without hand-resolving.
- **Triage issues** — respond to common questions, apply labels, link related issues and PRs, or draft implementation plans.
- **Anything ad hoc** — tag `@pullfrog` in any issue, PR, or comment. It pulls in the surrounding context and figures out what to do. Prompt from the [console](https://pullfrog.com/console) for anything else.

Each automation can be toggled from the dashboard and customized with per-trigger instructions.

## Get started

Run one command in any local repo:

```sh
npx pullfrog init
```

Or [install from the browser](https://pullfrog.com/console). Setup takes about two minutes: install the GitHub App, add the `pullfrog.yml` workflow with one click, and pick a model. See [getting started](https://docs.pullfrog.com/getting-started).

## Runs on the subscription you already pay for

No API key required. Connect a coding-agent plan once and every run bills against it:

| Plan | Connect with |
| --- | --- |
| [Claude Pro/Max](https://docs.pullfrog.com/claude-auth) | `npx pullfrog auth claude` |
| [ChatGPT Codex](https://docs.pullfrog.com/codex-auth) | `npx pullfrog auth codex` |
| [Grok](https://docs.pullfrog.com/grok-auth) | `npx pullfrog auth grok` |
| [Kimi Code](https://docs.pullfrog.com/kimi-code) | a Kimi Code key as `KIMI_API_KEY` |
| [OpenCode Go](https://docs.pullfrog.com/models#opencode-zen-and-opencode-go) | an OpenCode key as `OPENCODE_API_KEY` |

## Or bring your own model

Pullfrog works with any LLM provider: Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, OpenRouter, and more. Switch models with a config change. Two more ways to pay for tokens:

- **Your own API key** — stored in Pullfrog's encrypted secret store or in GitHub Actions secrets, your choice.
- **Router** — Pullfrog's built-in model access, billed at raw provider cost with no markup.

## Batteries included

- 🛠️ **MCP tools for GitHub** — a purpose-built MCP server for git and GitHub operations: creating PRs, leaving reviews and comments, reading CI logs, managing issues. Every operation goes through Pullfrog's permission layer.
- 🛡️ **Secure shell access** — shell commands run in an isolated subprocess without access to sensitive environment variables.
- 🌐 **Headless browser** — for end-to-end tests, screenshots, and UI iteration, with screenshot uploads out of the box.
- 🔑 **Short-lived credentials** — all GitHub operations use an installation token that is auto-revoked when the run completes. Keys are auto-masked in logs, and only the minimum necessary environment variables pass through to the agent.
- 🪝 **Hooks** — setup, post-checkout, pre-push, and stop scripts that run inside the agent's permission boundary. A stop script that exits non-zero resumes the agent with the failure as context, so it fixes its own broken push instead of opening a red PR.
- 🔐 **GitHub-native permissions** — GitHub remains the single source of truth for access control. Users only see repos they already have access to; org settings require an org owner.

## Pricing

Pullfrog is free for developers on personal GitHub accounts and free for open-source repos. Pro is $30/month for the whole organization with no per-run or per-seat billing — required for an org's private repos, optional everywhere else. Pullfrog also covers model cost for impactful open-source projects — [apply here](https://pullfrog.com/for-oss).

## Standalone usage

The same `pullfrog/pullfrog@v0` action that powers the automations above also works as a step in your own workflows — an agent as one stage of a larger pipeline. The action takes a `prompt` and the provider key of your choice; the only permission it needs is `id-token: write`, which lets it mint its own short-lived GitHub token.

```yaml
# .github/workflows/agent.yml — run any prompt on demand
name: Agent
on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What should the agent do?
        required: true

jobs:
  agent:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pullfrog/pullfrog@v0
        with:
          prompt: ${{ inputs.prompt }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action also exposes a `result` output that subsequent steps can consume. See [CI integration](https://docs.pullfrog.com/headless-action) for the full guide.

<details>
<summary><strong>Example: auto-generate release notes on new tags</strong></summary>

```yaml
name: Release
on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate release notes
        id: notes
        uses: pullfrog/pullfrog@v0
        with:
          prompt: |
            Generate release notes for ${{ github.ref_name }}.
            Compare commits between this tag and the previous tag.
            Format as markdown: summary paragraph, then ### Features, ### Fixes, ### Breaking Changes sections.
            Omit empty sections. Be concise.
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      # write to file to avoid shell escaping issues with special characters
      - name: Create GitHub release
        run: |
          notesfile="$RUNNER_TEMP/release-notes-$GITHUB_RUN_ID.md"
          printf '%s' "$NOTES" > "$notesfile"
          gh release create ${{ github.ref_name }} --title "${{ github.ref_name }}" --notes-file "$notesfile"
        env:
          GH_TOKEN: ${{ github.token }}
          NOTES: ${{ steps.notes.outputs.result }}
```

</details>

<details>
<summary><strong>Example: prompt from a file</strong></summary>

For longer prompts you want to version and reuse, commit the prompt text to the repo and pass its path with `prompt_file` instead of inlining it. The path is resolved relative to `GITHUB_WORKSPACE`, and it is mutually exclusive with `prompt` — set exactly one.

```yaml
# .github/workflows/triage.yml
- uses: actions/checkout@v4
- uses: pullfrog/pullfrog@v0
  with:
    prompt_file: .github/pullfrog/triage.md
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

</details>

<details>
<summary><strong>Structured output</strong></summary>

Pass a JSON Schema via the `output_schema` input to make the agent's output required and validated — the bridge between an agent's reasoning and the hard steps that follow it. See [capturing agent output](https://docs.pullfrog.com/headless-action#capturing-agent-output) for the details and a worked example.

</details>

## Azure DevOps (experimental)

Pullfrog can run as a pull-request reviewer in **Azure Repos** from an **Azure Pipelines build-validation policy**. This path does not require a service hook, webhook, GitHub App, or separate Pullfrog deployment: the pipeline job supplies PR context through Azure's predefined variables, the agent reviews the source-commit diff, and Pullfrog publishes a summary, reliable inline findings, and an iteration-scoped PR status through the Azure DevOps REST API.

> Azure Repos does **not** use a YAML `pr:` trigger. Add the pipeline as a [**Build validation** policy](https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies?view=azure-devops#set-build-validation) on the target branch instead. The `System.PullRequest.*` variables used by `pullfrog azdo review` are populated for those policy-triggered PR builds.

A minimal Azure OpenAI setup:

```yaml
trigger: none

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    fetchDepth: 0
    persistCredentials: true

  - script: npx --yes pullfrog azdo review
    displayName: Pullfrog review
    env:
      # Explicitly expose the job token to scripts. The build-service identity
      # needs "Contribute to pull requests" on this repository.
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)

      # Azure OpenAI model configuration
      AZURE_API_KEY: $(AZURE_API_KEY)
      AZURE_RESOURCE_NAME: $(AZURE_RESOURCE_NAME)
      AZURE_DEPLOYMENT: $(AZURE_DEPLOYMENT)
      AZURE_CONTEXT: $(AZURE_CONTEXT)
      AZURE_MAX_OUTPUT: $(AZURE_MAX_OUTPUT)
      # Optional for deployments that require Chat Completions rather than Responses:
      # AZURE_USE_CHAT_COMPLETIONS: "true"
```

Configure these values as pipeline variables or a variable group, marking `AZURE_API_KEY` secret. `AZURE_CONTEXT` and `AZURE_MAX_OUTPUT` are the context-window and maximum-output token counts for the model behind your deployment.

The Azure runtime is deliberately narrower than the GitHub Action today:

- automatic review and explicit thread follow-ups are implemented, and separate safe-write primitives can prepare/commit the current PR source branch; autonomous autofix, issue triage, CI-log repair, automatic comment-event transport, arbitrary branch/PR creation, and the Pullfrog cloud console remain GitHub-only;
- it runs OpenCode in an isolated temporary workspace with all native tools denied and treats PR metadata/diff content as untrusted input;
- it uses `System.AccessToken` by default; `AZURE_DEVOPS_PAT` is available as a local/debug fallback;
- rerunning the validation updates the existing Pullfrog summary and same-location inline threads, and closes Pullfrog findings that disappeared;
- `--dry-run` prints the review without writing to Azure DevOps, and `--model provider/model` can select a concrete OpenCode model that authenticates from pipeline environment variables instead of Azure OpenAI.

For Azure Repos, grant the pipeline's build-service identity **Contribute to pull requests** on the repository. Keep `fetchDepth: 0` and `persistCredentials: true` for the current review step: Pullfrog compares `System.PullRequest.SourceCommitId` with the target branch rather than assuming the validation job's checked-out `HEAD` is the PR source commit. If you use the safe-write flow below, `azdo checkout` removes those persisted credentials before any code-writing process is allowed to touch the repository.

### Interactive PR thread follow-ups

The first interactive Azure slice deliberately avoids Service Hooks. A trusted user queues a pipeline with the exact **PR, thread, and triggering comment IDs**, and Pullfrog answers that request in the originating Azure Repos thread:

```yaml
parameters:
  - name: pullRequestId
    type: number
  - name: threadId
    type: number
  - name: commentId
    type: number

trigger: none

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    fetchDepth: 0
    persistCredentials: true

  - script: >
      npx --yes pullfrog azdo follow-up
      --pull-request ${{ parameters.pullRequestId }}
      --thread ${{ parameters.threadId }}
      --comment ${{ parameters.commentId }}
    displayName: Pullfrog PR follow-up
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
      AZURE_API_KEY: $(AZURE_API_KEY)
      AZURE_RESOURCE_NAME: $(AZURE_RESOURCE_NAME)
      AZURE_DEPLOYMENT: $(AZURE_DEPLOYMENT)
      AZURE_CONTEXT: $(AZURE_CONTEXT)
      AZURE_MAX_OUTPUT: $(AZURE_MAX_OUTPUT)
```

The trigger is intentionally explicit:

- a comment triggers when it contains `@pullfrog`;
- a normal reply without a mention also triggers when it is inside a thread Pullfrog previously created for a review, inline finding, or follow-up;
- deleted, system/code-change, and Pullfrog-authored marker comments are ignored;
- `--resolve` closes the originating thread after the reply when that is explicitly requested by the queued run;
- `--dry-run` prints the answer without posting it.

Each reply carries a hidden marker keyed by **thread ID + triggering comment ID**. A retry first checks for that marker and reuses the existing comment. If two runs race and both create a reply, Pullfrog re-reads the thread, keeps the lowest matching comment ID, and deletes the later duplicate.

This slice uses **pipeline queue permission as the authorization boundary**: writing `@pullfrog` in a PR does not itself authorize a run. Only users allowed to queue this follow-up pipeline (and, where applicable, set its queue-time parameters) can cause Pullfrog to process a selected comment. Restrict those Azure Pipeline permissions to the people/groups you intend to authorize. The build-service identity still needs repository permission to read and write PR comment threads.

The model remains read-only and tool-free. Pullfrog captures the Azure REST credential, builds PR/thread/diff context, then scrubs `System.AccessToken` / PAT variables before starting OpenCode. Requests to modify code are answered as guidance only in this slice; they do not invoke the #6 write path or #7 autofix flow.

This is an **ad-hoc/manual transport**, not full automatic comment-event parity. A later #5 slice can add polling or Service Hooks on top of the same PR/thread/comment ingestion and idempotency contract without changing the agent-facing semantics.

### Safe PR-source writes

The first Azure write capability is intentionally narrow: it can prepare and finalize changes on the **current validated PR source branch only**. It does not yet create arbitrary branches or PRs, and it does not itself run a code-writing agent. That separation gives later autofix work a credential-safe substrate without granting the model direct repository credentials.

A pipeline can bracket a trusted code-writing step like this:

```yaml
  # Run after the review step while System.AccessToken is still available only
  # to Pullfrog itself.
  - script: npx --yes pullfrog azdo checkout --push restricted
    displayName: Prepare Pullfrog write checkout
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)

  # Your code-writing step goes here. Do NOT map System.AccessToken, an Azure
  # DevOps PAT, or another repository credential into this process.
  - script: ./run-your-code-writing-step.sh
    displayName: Produce working-tree changes

  - script: npx --yes pullfrog azdo commit --push restricted --message "fix: apply Pullfrog changes"
    displayName: Commit and push Pullfrog changes
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

`azdo checkout` verifies that `origin` is the Azure repository identified by `BUILD_REPOSITORY_URI`, fetches the PR source with parent-owned authentication, requires its remote tip to equal `System.PullRequest.SourceCommitId`, checks out that exact source commit, and removes checkout-persisted `http.*.extraheader` / credential-helper configuration.

`azdo commit` then requires the working tree to still be on that PR source with the validated commit as `HEAD`, rechecks the live PR source through the Azure REST API, re-fetches the remote source, creates the commit itself, and pushes with an explicit lease requiring the remote source ref to still equal the validated SHA. The generated commit must be a direct child of that SHA, so the lease acts as compare-and-swap protection rather than permitting a history rewrite. Any concurrent update or force-reset therefore fails closed instead of being overwritten.

The write permission vocabulary matches Pullfrog's GitHub runtime: `disabled`, `restricted`, and `enabled`, defaulting to `restricted`. In this PR-source-only slice, both `restricted` and `enabled` authorize only the current PR source; neither permits a direct target/default-branch write. Authenticated git runs in an isolated environment with hooks disabled while credentials are live. Changed Git-LFS files are rejected for now because safely supporting them requires the LFS pre-push hook.

Use `--dry-run` with `azdo commit` to run the stale/ref/change preflight without creating a commit or pushing.

### Merge-gating status

Each non-dry-run review publishes the Azure Repos PR status **`pullfrog/review`** on the exact source iteration being reviewed:

- `pending` while the review is running;
- `succeeded` only for a complete review with no actionable findings;
- `failed` when actionable findings exist;
- `error` when the diff was truncated or the review fails before a complete result is available.

To make this merge-gating, open the target branch's **Branch policies → Status checks**, add `pullfrog/review`, mark it **Required**, and enable **Reset status whenever there are new changes**. This keeps an old iteration's successful status from satisfying a newer source update.

Inline findings are only created when Pullfrog can validate the model's file/line against the actual right-hand diff and map the file to Azure's cumulative iteration changes. Other findings remain in the summary rather than creating a misleading anchor. Inline threads carry Azure's `changeTrackingId` plus the source iteration context so Azure can track them across later pushes.

### Provider boundary

The Azure review path now runs through the same provider-neutral PR-review contract that can be implemented by GitHub: a small `PullRequestReader` + `ReviewPublisher` boundary and a normalized Pullfrog PR snapshot. Platform SDK/REST response types stay inside their adapters rather than leaking into review orchestration.

Azure Pipelines build validation is treated as the automatic `validation` PR event adapter. Interactive follow-ups currently use an explicit PR/thread/comment pipeline invocation rather than a webhook. Service Hooks or polling can later supply automatic comment-event transport while reusing the same follow-up selection and idempotent reply path.

The Azure token boundary is unchanged. The provider captures REST authorization before Pullfrog scrubs Azure DevOps credentials from the process environment; the isolated OpenCode subprocess still cannot access `System.AccessToken`, `AZURE_DEVOPS_TOKEN`, or `AZURE_DEVOPS_PAT`.

Publication consistency is explicit rather than pretending the providers have identical atomicity. Azure's adapter is **source-convergent**: it revalidates around publication and closes/converges stale Pullfrog threads. GitHub's proof adapter is **best-effort** because GitHub review creation has no conditional “only if this is still the PR head” write; it rechecks after posting and reports if the head advanced during publication.

