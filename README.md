<p align="center">
  <h1 align="center">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/frog-white-200px.png">
      <img src="https://pullfrog.com/frog-green-200px.png" width="25px" align="center" alt="Green Pullfrog logo" />
    </picture><br />
    Pullfrog
  </h1>
  <p align="center">
    The BYOK CodeRabbit that runs in your CI
  </p>
</p>

<p align="center">
  <a href="https://pullfrog.com">pullfrog.com</a> · <a href="https://docs.pullfrog.com">Docs</a> · <a href="https://pullfrog.com/console">Console</a> · <a href="https://discord.gg/8y96raFg8e">Discord</a>
</p>

<br/>

> **New** — Pullfrog is now [free for personal and open-source usage](https://pullfrog.com/blog/free-for-open-source).

## What is Pullfrog?

Pullfrog is the BYOK CodeRabbit that runs in your CI. The hosted product is GitHub-native: it listens for GitHub events — PRs opened, issues created, reviews submitted, CI failures — and triggers agent runs based on your configuration via a `pullfrog.yml` workflow that uses this open-source action. You control the infrastructure, the keys, and the costs.

Pullfrog also has a CI-native **Azure DevOps** runtime for Azure Repos, Azure Pipelines, and Azure Boards. It does not require Service Hooks or a separate Pullfrog deployment: Azure Pipelines supplies the execution context and `System.AccessToken`, while Pullfrog handles review/task orchestration and publishes back through the Azure DevOps REST APIs. The hosted console remains GitHub-only.

Pullfrog is not an agent itself. It wraps vanilla **[Claude Code](https://github.com/anthropics/claude-code)**, **[Codex](https://github.com/openai/codex)**, and **[OpenCode](https://github.com/anomalyco/opencode)**, selecting the one that matches your BYOK or bring-your-own-subscription configuration — so every run uses the vendor's real agent, and it reads the repo-level config you already keep for it: `CLAUDE.md` or `AGENTS.md`, skills, custom commands, and repo-level MCP servers.

Out of the box, it can:

- **Review new PRs** — auto-review every incoming PR; the review verdict can gate merges via requireable status checks.
- **Address reviews** — leave review comments on a Pullfrog PR as you would for a human colleague, and it addresses them.
- **Autofix CI** — Pullfrog detects CI failures on its own PRs and attempts a fix. It can be configured to fix human PRs too.
- **Autofix merge conflicts** — keep PRs mergeable without hand-resolving.
- **Triage issues** — respond to common questions, apply labels, link related issues and PRs, or draft implementation plans.
- **Anything ad hoc** — tag `@pullfrog` in any issue, PR, or comment. It pulls in the surrounding context and figures out what to do. Prompt from the [console](https://pullfrog.com/console) for anything else.

Each GitHub automation can be toggled from the dashboard and customized with per-trigger instructions.

On Azure DevOps, the current CI-native runtime supports automatic PR review, inline findings and merge-gating status, interactive and scheduled follow-ups, safe PR-source writes, Pullfrog-owned branch/PR creation, CI failure and merge-conflict autofix, Azure Boards triage, and repository-level plan/build tasks. Azure setup/configuration currently lives in pipeline YAML/variables rather than the Pullfrog hosted console.

## Get started

Run one command in any local repo:

```sh
npx pullfrog init
```

Or [install from the browser](https://pullfrog.com/console). Setup takes about two minutes: install the GitHub App, add the `pullfrog.yml` workflow with one click, and pick a model. See [getting started](https://docs.pullfrog.com/getting-started).

For Azure DevOps, use the [Azure DevOps](#azure-devops-ci-native-experimental) setup below instead. Azure is currently pipeline-native rather than console-managed.

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

## Azure DevOps (CI-native, experimental)

Pullfrog supports the core review/task lifecycle across **Azure Repos**, **Azure Pipelines**, and **Azure Boards** using Azure Pipelines as the execution transport. This path does not require a Service Hook, webhook, GitHub App, or separate Pullfrog deployment.

For PR validation, an Azure Pipelines build-validation job supplies PR context through Azure's predefined variables. Pullfrog can review the source-commit diff, publish a convergent summary and reliable inline findings, set an iteration-scoped merge-gating status, handle follow-up requests, safely write fixes, create Pullfrog-owned PRs, and repair eligible CI failures or merge conflicts. Azure Boards work items can also drive triage, planning, related-item lookup, allowlisted field/tag updates, and repository-level implementation tasks through explicit commands or scheduled polling.

Every Azure review, follow-up, and work-item command requires `PULLFROG_AZDO_REVIEW_IDENTITY_ID`: the immutable `author.id` of the Azure identity that publishes Pullfrog comments (normally the pipeline build-service identity). Set it in each relevant step's environment; marker text from other authors is not treated as Pullfrog output.

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
      PULLFROG_AZDO_REVIEW_IDENTITY_ID: $(PULLFROG_AZDO_REVIEW_IDENTITY_ID)

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

The Azure runtime now covers the core CI-native workflow, with a few intentional platform/product differences:

- automatic review, inline/status publication, explicit and scheduled thread follow-ups, safe PR-source writes, Pullfrog-owned branch/PR creation, bounded CI autofix, and merge-conflict repair are implemented;
- Azure Boards work-item triage, bounded related-item search, comments, allowlisted tag/state updates, and repository-level `links` / `plan` / `build` / `custom` tasks are implemented;
- work-item and follow-up polling provide a no-Service-Hook transport when webhook administration is unavailable;
- review/follow-up models run read-only; repair/build models receive only the bounded repository tools required for the task, while shell/web/task access and Azure repository credentials remain denied;
- `System.AccessToken` is the normal Azure Pipelines authentication path; `AZURE_DEVOPS_PAT` is retained only as a local/debug fallback;
- rerunning validation converges the existing Pullfrog summary and same-location inline threads, and closes Pullfrog findings that disappeared;
- `--dry-run` is supported by review and repair commands, and `--model provider/model` can select a concrete OpenCode model that authenticates from pipeline environment variables instead of Azure OpenAI;
- the hosted Pullfrog console, central secret/configuration management, install lifecycle, and cloud run visibility remain GitHub-only. Azure configuration is intentionally pipeline/repository managed for now.

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
      PULLFROG_AZDO_REVIEW_IDENTITY_ID: $(PULLFROG_AZDO_REVIEW_IDENTITY_ID)
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

Each reply carries a hidden marker keyed by **thread ID + triggering comment ID**. Before any non-dry-run model execution, Pullfrog also acquires an atomic Azure Git ref lock for that exact request. The lock is a deterministic transient branch under `refs/heads/pullfrog/locks/follow-up/`. Azure creates it only when the ref's old object ID is all zeros; if another worker already created the ref, Azure returns `staleOldObjectId` and the losing worker exits before invoking the model. A retry still checks the final reply marker first and reuses the existing response.

This slice uses **pipeline queue permission as the authorization boundary**: writing `@pullfrog` in a PR does not itself authorize a run. Only users allowed to queue this follow-up pipeline (and, where applicable, set its queue-time parameters) can cause Pullfrog to process a selected comment. Restrict those Azure Pipeline permissions to the people/groups you intend to authorize. The build-service identity needs repository permission to read/write PR comment threads and `Create branch` on the Pullfrog lock namespace. Azure branch permissions can be scoped by branch folder, so prefer granting that permission only under `pullfrog/locks` rather than repo-wide.

The model remains read-only and tool-free. Pullfrog captures the Azure REST credential, builds PR/thread/diff context, then scrubs `System.AccessToken` / PAT variables before starting OpenCode. Requests to modify code are answered as guidance only in this slice; they do not invoke the #6 write path or #7 autofix flow.

The manual command remains useful for explicit operator-selected requests. Scheduled polling can automate discovery without Service Hooks; Service Hooks can later be added as another transport over the same PR/thread/comment semantics.

### Scheduled follow-up polling

If Service Hooks/webhooks are unavailable, `poll-follow-ups` can make the interactive path automatic by scanning active PRs on a schedule:

```yaml
trigger: none

schedules:
  - cron: "*/10 * * * *"
    displayName: Pullfrog follow-up poll
    branches:
      include:
        - main
    always: true

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    fetchDepth: 0
    persistCredentials: true

  - script: npx --yes pullfrog azdo poll-follow-ups --max 5
    displayName: Poll Azure PR follow-ups
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
      PULLFROG_AZDO_REVIEW_IDENTITY_ID: $(PULLFROG_AZDO_REVIEW_IDENTITY_ID)

      # Required safety gates for automatic transport.
      # Comma-separated immutable Azure IdentityRef IDs from comment.author.id.
      PULLFROG_AZDO_ALLOWED_ACTOR_IDS: $(PULLFROG_AZDO_ALLOWED_ACTOR_IDS)
      # Fixed rollout boundary. Comments older than this are never backfilled.
      PULLFROG_AZDO_POLL_AFTER: "2026-10-04T00:00:00Z"

      AZURE_API_KEY: $(AZURE_API_KEY)
      AZURE_RESOURCE_NAME: $(AZURE_RESOURCE_NAME)
      AZURE_DEPLOYMENT: $(AZURE_DEPLOYMENT)
      AZURE_CONTEXT: $(AZURE_CONTEXT)
      AZURE_MAX_OUTPUT: $(AZURE_MAX_OUTPUT)
```

The poller uses Azure Repos' active-PR list plus each PR's thread list. It never trusts display names for automatic execution: a candidate comment must have an `author.id` present in `PULLFROG_AZDO_ALLOWED_ACTOR_IDS`. The `--after` / `PULLFROG_AZDO_POLL_AFTER` cutoff is also required so enabling polling cannot unexpectedly process historical requests.

Eligible requests use the same semantics as the manual command: explicit `@pullfrog` mentions anywhere, or replies inside Pullfrog-owned threads. Already-handled marker comments are discarded before model invocation. Eligible requests are processed oldest-first, and `--max` caps model-backed work to 1–50 requests per scheduled run (default 10).

Azure YAML schedules use UTC cron expressions. `always: true` is important here because comments can change without the repository source changing.

Follow-up execution is now **atomically serialized before model execution** as well as publication-convergent. The worker tries to create a deterministic lock ref such as `refs/heads/pullfrog/locks/follow-up/pr-42-thread-17-comment-4` using Azure's Git ref update API with `oldObjectId=000...000` and the current PR source commit as `newObjectId`. Azure documents the old/new object comparison specifically to prevent ref-update races; when another worker wins first, the loser receives `staleOldObjectId` and does not run the model.

The lock has no lease or time-based expiry. That is intentional: a long-running model cannot outlive the mutex and allow duplicate work. Pullfrog releases the ref with an exact old-object CAS after the attempt finishes. If release fails, the deterministic lock remains and later runs fail closed. Likewise, if the acquisition HTTP request becomes ambiguous after the server may have committed it, Pullfrog aborts instead of guessing ownership. An operator may need to remove a leaked lock ref before retrying, but the failure mode is a stuck request rather than duplicate model execution.

Because the lock lives in Git refs rather than PR comments, arbitrary commenters cannot forge or delete coordination state by pasting marker text. Azure's branch-folder permission model can restrict `Create branch` to the `pullfrog/locks` namespace; branch creators receive direct permissions on branches they create, which permits normal cleanup of their own transient lock refs.

The immutable actor allowlist is the authorization boundary for **automatic** polling. The manually queued `follow-up` command retains its separate pipeline-queue authorization model, but both transports share the same atomic ref-lock path so a manual run and scheduled poll cannot process the same request concurrently. `--dry-run` remains write-free and does not create a lock.

### Azure Boards work-item triage and repository tasks

Azure Boards uses the same **conceptual issue configuration** as the GitHub runtime rather than a parallel Azure-only mode catalogue:

- `PULLFROG_ISSUE_MODE=none|links|plan|build|custom` projects the existing `issue.mode` concept into the pipeline runtime;
- `PULLFROG_ISSUE_INSTRUCTIONS` carries the existing issue/work-item instructions;
- `PULLFROG_LABEL_ENABLED` and `PULLFROG_LABEL_INSTRUCTIONS` project issue-label behavior onto Azure **tags**;
- Azure-only security constraints stay narrow: `PULLFROG_AZDO_ALLOWED_ACTOR_IDS`, `PULLFROG_AZDO_WORK_ITEM_ALLOWED_FIELDS`, and `PULLFROG_AZDO_WORK_ITEM_ALLOWED_STATES`.

A manually queued run can handle a created work item:

```bash
pullfrog azdo work-item \
  --work-item 42 \
  --mode plan \
  --allowed-actor-ids "$PULLFROG_AZDO_ALLOWED_ACTOR_IDS"
```

or one explicit discussion comment:

```bash
pullfrog azdo work-item \
  --work-item 42 \
  --comment 17 \
  --allowed-actor-ids "$PULLFROG_AZDO_ALLOWED_ACTOR_IDS"
```

Work-item comments must explicitly mention `@pullfrog`. They can also choose an action, for example `@pullfrog links`, `@pullfrog plan`, `@pullfrog build`, or `@pullfrog custom ...`. An explicit comment action can opt into a one-off task even when automatic created-item handling is `none`.

Automatic discovery does not require Service Hooks. A scheduled pipeline can use:

```bash
pullfrog azdo poll-work-items \
  --after 2026-10-05T00:00:00Z \
  --max 5
```

with `PULLFROG_AZDO_ALLOWED_ACTOR_IDS` set to comma-separated immutable Azure IdentityRef IDs. The poller uses keyset-paginated, project-scoped WIQL over recently changed work items, with a fixed changed-date cutoff and an immutable work-item-ID cursor. Work-item detail fetches use bounded concurrency rather than a fan-out across the whole page. The scan has an explicit 5,000-item safety bound; reaching it is reported as a failure instead of silently starving later items. It then considers only created items or comments at/after the rollout cutoff. Display names and email addresses are never authorization inputs.

#### GitHub issue → Azure Boards mapping

| Pullfrog concept | GitHub | Azure Boards |
| --- | --- | --- |
| issue identity | issue number | work-item ID + revision |
| title/body/state | native issue fields | `System.Title`, description/repro steps, `System.State` |
| labels | labels | tags |
| assignee/author | GitHub login | normalized Azure identity with immutable `id` |
| discussion | issue comments | Work Item Comments API |
| relationships | cross-reference / commit timeline events | work-item relations + artifact links (work items, PRs, commits, hyperlinks) |
| search | bounded GitHub issue search | bounded project-scoped WIQL retrieval |
| similar issues | hosted Pullfrog similarity candidate retrieval | no fabricated equivalent; WIQL candidates are retrieval only |
| milestone | milestone | no forced mapping; Azure iteration/process fields remain platform-specific |
| plan/fix enrichment links | Pullfrog hosted trigger URLs | explicit `@pullfrog plan/build` comments or queued pipeline parameters |

Pullfrog reads complete discussion only up to explicit item/count/character bounds, caps relationship/search context, and treats **all** work-item/comment/relation/search text as untrusted prompt data. Repository files are likewise untrusted context. Only the selected request and configured Pullfrog instructions are instructions to the model.

Work-item mutations fail closed:

- there is no generic JSON Patch tool or arbitrary field-reference update;
- model-controlled writes are limited to tags and/or state, and only when those fields are explicitly listed in `PULLFROG_AZDO_WORK_ITEM_ALLOWED_FIELDS`;
- state mutation additionally requires an explicit `PULLFROG_AZDO_WORK_ITEM_ALLOWED_STATES` allowlist;
- every work-item update carries an optimistic-concurrency revision test and is rejected if the item advanced;
- generated implementation PRs may add a Pullfrog-owned hyperlink relation; its URL is generated by the parent process, not by the model.

For automatic or manually selected work-item execution, Pullfrog also creates a deterministic coordination ref under:

```text
refs/heads/pullfrog/locks/work-item/
```

The lock key includes only immutable event identity: work-item ID plus triggering comment ID, or the created-item event. Work-item revision is deliberately not part of the lock key, so an unrelated edit cannot allow the same comment event to execute concurrently under a new lock name. Revision remains a separate stale-write guard. Creation is an all-zero old-object CAS; contention exits before model work. For `links` / `plan` / `custom` and build attempts that have not created a PR, release uses the exact repository commit used to anchor the lock. Once a `build` request creates its Azure Repos PR, Pullfrog deliberately retains that event-keyed ref as a durable idempotency record. This makes a later Boards comment/link publication failure fail closed instead of allowing the same event to create a second PR.

#### Repository-level work-item tasks

`links` is deterministic and model-free: it posts explicit Azure work-item/PR/commit relationships plus bounded WIQL candidates.

`plan` and `custom` run the model with repository **read/glob/grep** access only. Shell, edits, web access, subagents, project config/plugins/skills, `.git/config`, external directories, and Azure repository credentials remain denied. The parent validates the model's structured response before applying any allowlisted tag/state mutations.

`build` requires `--push enabled` (or `PULLFROG_PUSH=enabled`) because it creates a new Pullfrog-owned branch. The flow deliberately reuses the safe-write path established for Azure Repos:

1. authenticate/authorize the immutable work-item actor and acquire the deterministic event lock;
2. fetch bounded work-item/discussion/relationship/search context;
3. create a branch under `pullfrog/branches/work-item-...` from an exact default-branch SHA, with the normal ownership proof;
4. create a disposable Git worktree, prepare the generated branch there, and remove persisted git credentials;
5. run the code-writing model inside that isolated worktree with repository read/edit/glob/grep only—no shell, git metadata, web, or Azure credentials;
6. reject the result if the work item advanced while the model was working;
7. have the parent create the commit and CAS-push through the existing owned-branch safe-write path;
8. create the Azure Repos PR through the existing ownership/source-staleness checks;
9. record the generated PR on the work item as a hyperlink where possible and post the final marked response.

The disposable worktree is removed in a guaranteed cleanup path, including stale-item/model failures, so one polled work item cannot leave uncommitted files or a generated branch checked out for the next candidate. If the model makes no working-tree changes, Pullfrog deletes the temporary Pullfrog branch and records that no PR was opened. If PR creation fails, it attempts to clean up the Pullfrog-owned branch. It never deletes user-owned branches, work items, or PRs.

The build-service identity needs Azure Boards read/comment access for `links/plan/custom`. Tag/state updates require work-item write permission. `build` additionally needs the existing Azure Repos branch/PR permissions plus scoped branch creation under `pullfrog/branches` and `pullfrog/locks/work-item`.

Service Hooks are intentionally a transport follow-up rather than part of the work-item domain model. The CI/manual/polling path is usable without webhook administration, and a future Service Hook adapter can feed the same normalized work-item trigger/auth/deduplication semantics.

### Safe PR-source writes

Azure writes use the same permission vocabulary as Pullfrog's GitHub runtime: `disabled`, `restricted`, and `enabled`, defaulting to `restricted`.

- `restricted` can only update the **current validated PR source branch**.
- `enabled` includes that behavior and can additionally create/write branches under the reserved `pullfrog/branches/` namespace, then open a PR from one of those Pullfrog-owned branches.
- neither mode permits direct writes to the repository default branch or current PR target branch.

For an existing PR, a pipeline can bracket a trusted code-writing step like this:

```yaml
  - script: npx --yes pullfrog azdo checkout --push restricted
    displayName: Prepare Pullfrog write checkout
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)

  # Do NOT map System.AccessToken, an Azure DevOps PAT, or another repository
  # credential into the code-writing/model process.
  - script: ./run-your-code-writing-step.sh
    displayName: Produce working-tree changes

  - script: npx --yes pullfrog azdo commit --push restricted --message "fix: apply Pullfrog changes"
    displayName: Commit and push Pullfrog changes
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

`azdo checkout` verifies that `origin` is the Azure repository identified by `BUILD_REPOSITORY_URI`, fetches the PR source with parent-owned authentication, requires its remote tip to equal `System.PullRequest.SourceCommitId`, checks out that exact source commit, and removes checkout-persisted `http.*.extraheader` / credential-helper configuration.

`azdo commit` then requires the working tree to still be on that PR source with the validated commit as `HEAD`, rechecks the live PR source through the Azure REST API, re-fetches the remote source, creates the commit itself, and pushes with an explicit lease requiring the remote source ref to still equal the validated SHA. The generated commit must be a direct child of that SHA, so the lease acts as compare-and-swap protection rather than permitting a history rewrite.

For new Pullfrog work, `enabled` supports a complete branch-to-PR flow:

```bash
# Creates the remote branch at the current target SHA using Azure's ref CAS API,
# creates a companion ownership ref, fetches it with parent-owned credentials,
# and prepares the local checkout.
pullfrog azdo branch-create \
  --push enabled \
  --branch pullfrog/branches/fix-123 \
  --target main

# Run the code-writing/model process here WITHOUT Azure repository credentials.

# The expected SHA is the SHA printed by branch-create. Pullfrog creates the
# commit itself and pushes with an explicit lease.
pullfrog azdo branch-commit \
  --push enabled \
  --branch pullfrog/branches/fix-123 \
  --target main \
  --expected <branch-create-sha> \
  --message "fix: apply Pullfrog changes"

# Use the SHA printed by branch-commit.
pullfrog azdo create-pr \
  --push enabled \
  --branch pullfrog/branches/fix-123 \
  --target main \
  --expected <branch-commit-sha> \
  --title "fix: apply Pullfrog changes"
```

New-branch creation is not authorized by branch naming alone. Pullfrog creates a deterministic companion ref under `pullfrog/owners/` and `create-pr` requires it as a coordination/provenance check before it will open a PR. **That ref is not an authorization boundary**: repository identities that can freely create refs could forge it, so automatic write authorization must come from the pipeline identity/permissions and the exact-source trusted-review checks described below. Restrict creation/update/deletion of the `pullfrog/*` namespaces to the build-service identity where repository permissions allow it. Branch creation itself uses `oldObjectId=000...000`, so an existing/racing branch fails closed. PR creation revalidates the exact source SHA before and after Azure's non-conditional create request; if the source moves during creation, Pullfrog immediately abandons the new PR.

Authenticated git always runs in an isolated environment with hooks and credential helpers disabled while the Azure credential is live. Changed Git-LFS files remain unsupported because safely pushing them requires the LFS pre-push hook.

Use `--dry-run` with `azdo commit` or `azdo branch-commit` to run the stale/ref/change preflight without creating a commit or pushing.

The destructive authenticated-git integration test is opt-in and should point only at a disposable Azure Repos repository:

```bash
export PULLFROG_AZDO_INTEGRATION=1
export PULLFROG_AZDO_INTEGRATION_REPOSITORY_ID="$BUILD_REPOSITORY_ID"
pnpm test:azdo-integration
```

The test creates a temporary Pullfrog-owned branch, authenticated-fetches it, commits/pushes through the production CAS path, verifies the remote SHA, then deletes the branch and ownership ref. The extra repository-ID confirmation prevents accidentally enabling the destructive test against an unintended repository.

### CI failure autofix

`azdo autofix-ci` is intended to run **inside the failing Azure Repos build-validation job**, after the repository's normal validation steps. It identifies the failed build by `--build`, then `BUILD_BUILDID`, then exact PR/source discovery through the Azure Build API.

A typical validation pipeline can add a final step like:

```yaml
  - script: >
      npx --yes pullfrog azdo autofix-ci
      --push restricted
      --requeue
    displayName: Pullfrog CI repair
    condition: failed()
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)

      # Opt-in policy. Both default to disabled.
      PULLFROG_AZDO_FIX_CI_OWN_PRS: "enabled"
      # Enable only if Pullfrog should modify human-authored PRs that it has
      # already reviewed at the exact failing source SHA.
      PULLFROG_AZDO_FIX_CI_REVIEWED_PRS: "enabled"
      # Immutable Azure IdentityRef id for the identity that publishes Pullfrog
      # review comments (normally the pipeline/build-service identity).
      PULLFROG_AZDO_REVIEW_IDENTITY_ID: $(PULLFROG_AZDO_REVIEW_IDENTITY_ID)
      PULLFROG_AZDO_MAX_REPAIR_ATTEMPTS: "3"

      AZURE_API_KEY: $(AZURE_API_KEY)
      AZURE_RESOURCE_NAME: $(AZURE_RESOURCE_NAME)
      AZURE_DEPLOYMENT: $(AZURE_DEPLOYMENT)
      AZURE_CONTEXT: $(AZURE_CONTEXT)
      AZURE_MAX_OUTPUT: $(AZURE_MAX_OUTPUT)
```

The CI repair path fails closed on identity and staleness:

- the build must belong to the current PR and exact source commit; for normal Azure Repos policy builds Pullfrog reads `pr.number` plus the serialized `System.PullRequest.SourceCommitId` build parameter, and also pins the synthetic merge revision when Azure exposes one;
- Pullfrog revalidates the live PR source and target before consuming a repair-attempt slot;
- failed job/task logs—and `succeededWithIssues` diagnostics for partially-succeeded builds—are selected from the Azure build timeline, deduplicated by log ID, redacted, and bounded before they enter model context;
- log text is explicitly treated as untrusted prompt data;
- human-authored PRs are eligible only when `PULLFROG_AZDO_FIX_CI_REVIEWED_PRS` is enabled and a review marker for that exact source SHA was authored by the immutable Azure identity configured in `PULLFROG_AZDO_REVIEW_IDENTITY_ID`; marker text from the PR author is never sufficient;
- Pullfrog-authored PRs require `PULLFROG_AZDO_FIX_CI_OWN_PRS`, the companion ownership ref, **and** an exact-source review marker authored by the immutable identity in `PULLFROG_AZDO_REVIEW_IDENTITY_ID`; the deterministic ownership ref alone never authorizes an autofix;
- before model execution Pullfrog atomically reserves a durable ref such as `refs/heads/pullfrog/repairs/pr-42/ci/attempt-1`; the source SHA stored in that ref suppresses duplicate workers and repeated repair of the same revision;
- the attempt budget is deterministic (default 3, configurable from 1–10) and is retained across source updates rather than using a time-based lease;
- the repair model can inspect/edit repository files but has no shell, web, task, or Azure repository credential access;
- Pullfrog—not the model—revalidates the source, creates the commit, and CAS-pushes it through the #6 safe-write path.

If the repair produces a commit, the source push normally causes Azure branch policy to run validation again. When `autofix-ci` runs inside the failing job, Pullfrog may collect failed timeline records while the overall build is still `inProgress`; that allows repair without pretending the build has already completed. If the model concludes that no source change is needed, `--requeue` queues nothing until the original build has a final `failed` or `partiallySucceeded` result. A completed failed build can then be requeued only while the PR source/target/merge revision still matches.

For an explicit operator retry without model repair:

```bash
pullfrog azdo requeue-build --build <failed-build-id>
```

The build-service identity needs normal build-read access for timelines/logs and permission to queue the relevant pipeline when requeue is enabled. The repository identity also needs the existing safe-write permissions plus branch creation under the durable `pullfrog/repairs/` coordination namespace.

### Merge-conflict autofix

`azdo autofix-conflicts` asks Azure Repos for the current PR `mergeStatus` and only proceeds for supported `conflicts` / merge-`failure` states. Because a conflicted PR may not produce a usable policy validation build, this command is designed to be invoked from a separately queued or scheduled pipeline with an explicit PR ID:

```bash
pullfrog azdo autofix-conflicts \
  --pull-request 42 \
  --push restricted \
  --max-attempts 3
```

Conflict repair uses the same durable repair budget under `pullfrog/repairs/pr-<id>/conflict/attempt-<n>`. The parent process checks out the exact live PR source, resolves the exact live target commit, and starts `git merge --no-commit --no-ff` with Azure credentials removed, hooks isolated, system/global git config disabled, and executable local merge/filter configuration rejected.

Only conflict-marked repository files are handed to the repair model for editing. The model cannot commit or push. Before finalization Pullfrog verifies that:

- the local branch and `HEAD` are still the validated PR source;
- `MERGE_HEAD` is still the validated target SHA;
- no expected conflict markers or unmerged paths remain;
- the live and freshly fetched source/target refs are unchanged;
- changed Git-LFS files are still rejected.

Pullfrog then creates the merge commit itself, verifies its first parent is the original source and second parent is the validated target, and CAS-pushes the PR source branch. Any failure leaves the remote untouched; the command attempts `git merge --abort` before returning when a local merge was prepared but not safely finalized.

Use `--dry-run` to prepare/inspect the repair prompt without reserving a durable attempt or pushing a commit.

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

Azure Pipelines build validation is treated as the automatic `validation` PR event adapter. Interactive PR follow-ups and Azure Boards work items both support explicit/manual invocation plus scheduled polling. Boards uses separate capability-sized work-item reader/comment/mutator/search contracts rather than expanding the PR provider into a giant generic SCM abstraction. Service Hooks can later become another transport while reusing the same normalized trigger selection, immutable-actor authorization, and deterministic deduplication paths.

The Azure token boundary is unchanged. The provider captures REST authorization before Pullfrog scrubs Azure DevOps credentials from the process environment; the isolated OpenCode subprocess still cannot access `System.AccessToken`, `AZURE_DEVOPS_TOKEN`, or `AZURE_DEVOPS_PAT`.

Publication consistency is explicit rather than pretending the providers have identical atomicity. Azure's adapter is **source-convergent**: it revalidates around publication and closes/converges stale Pullfrog threads. GitHub's proof adapter is **best-effort** because GitHub review creation has no conditional “only if this is still the PR head” write; it rechecks after posting and reports if the head advanced during publication.
