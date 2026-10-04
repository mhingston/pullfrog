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

Pullfrog can run as a read-only pull-request reviewer in **Azure Repos** from an **Azure Pipelines build-validation policy**. This path does not require a service hook, webhook, GitHub App, or separate Pullfrog deployment: the pipeline job supplies PR context through Azure's predefined variables, the agent reviews the source-commit diff, and Pullfrog publishes a summary, reliable inline findings, and an iteration-scoped PR status through the Azure DevOps REST API.

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

The reviewer is deliberately narrower than the GitHub Action today:

- it supports Azure Repos PR **review** only; issue triage, autofix, pushes, CI-log repair, review-thread resolution, and the Pullfrog cloud console remain GitHub-only;
- it runs OpenCode in an isolated temporary workspace with all native tools denied and treats PR metadata/diff content as untrusted input;
- it uses `System.AccessToken` by default; `AZURE_DEVOPS_PAT` is available as a local/debug fallback;
- rerunning the validation updates the existing Pullfrog summary and same-location inline threads, and closes Pullfrog findings that disappeared;
- `--dry-run` prints the review without writing to Azure DevOps, and `--model provider/model` can select a concrete OpenCode model that authenticates from pipeline environment variables instead of Azure OpenAI.

For Azure Repos, grant the pipeline's build-service identity **Contribute to pull requests** on the repository. Keep `fetchDepth: 0` and `persistCredentials: true`: Pullfrog compares `System.PullRequest.SourceCommitId` with the target branch rather than assuming the validation job's checked-out `HEAD` is the PR source commit.

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

Azure Pipelines build validation is also treated as the first Azure event adapter and normalized as a `validation` PR event. This does **not** add Service Hooks or a general webhook service: build validation is sufficient for automatic PR review, while interactive comment/follow-up parity remains a later capability that may require Service Hooks.

The Azure token boundary is unchanged. The provider captures REST authorization before Pullfrog scrubs Azure DevOps credentials from the process environment; the isolated OpenCode subprocess still cannot access `System.AccessToken`, `AZURE_DEVOPS_TOKEN`, or `AZURE_DEVOPS_PAT`.

Publication consistency is explicit rather than pretending the providers have identical atomicity. Azure's adapter is **source-convergent**: it revalidates around publication and closes/converges stale Pullfrog threads. GitHub's proof adapter is **best-effort** because GitHub review creation has no conditional “only if this is still the PR head” write; it rechecks after posting and reports if the head advanced during publication.

