# Azure DevOps feature parity backlog

PR #1 establishes the first Azure DevOps vertical slice: pipeline-native Azure Repos PR review without service hooks or separately deployed infrastructure.

This document is the issue-ready backlog for reaching feature parity with the GitHub runtime. GitHub Issues are currently disabled on this fork, so each section below is intentionally written as a self-contained issue draft. Once Issues are enabled, create one issue per section and replace the checklist items with links.

## Parity tracker

- [ ] Provider abstraction and Azure event ingestion
- [ ] Inline PR review threads and merge-gating status
- [ ] Interactive comments, review follow-ups, and ad-hoc triggers
- [ ] Safe write path for commits, pushes, and PR updates
- [ ] CI failure and merge-conflict autofix parity
- [ ] Work-item triage and repository-level task parity
- [ ] Console, configuration, secrets, and auth parity

## 1. Provider abstraction and Azure event ingestion

### Goal

Create the durable platform boundary needed for Azure DevOps to reach GitHub feature parity without duplicating the Pullfrog runtime.

### Scope

- define an SCM/provider interface for repository, PR, comment/review, status/check, branch, commit, and CI operations
- move GitHub-specific implementations behind that interface without regressing GitHub behavior
- implement an Azure DevOps provider using Azure DevOps REST APIs
- map GitHub event concepts to a provider-neutral run/event shape
- define Azure event ingestion:
  - Azure Pipelines/build-policy native triggers where sufficient
  - Azure DevOps Service Hooks or a polling alternative where interactive parity requires them
- preserve least-privilege auth boundaries and keep provider tokens out of agent subprocesses
- add provider contract tests shared by GitHub and Azure implementations

### Done when

- core orchestration can run against GitHub or Azure without importing platform-specific SDK/types
- GitHub remains the reference behavior and existing tests pass
- Azure event/auth strategy is documented with minimum permissions
- downstream parity work builds on the provider interface rather than one-off REST calls

## 2. Inline PR review threads and merge-gating status

### Goal

Bring Azure Repos review output closer to Pullfrog's GitHub review experience.

### Scope

- translate findings to Azure Repos file/line thread contexts
- create/update/resolve inline PR threads idempotently
- preserve source/target iteration context after PR updates
- publish an Azure DevOps PR status/check for the review result
- support branch-policy/merge-gating semantics comparable to GitHub required status checks
- define machine-readable behavior for partial/truncated reviews
- cover force-push/new-iteration behavior and stale-run suppression

### Done when

- actionable findings are inline when a reliable location exists
- reruns update/resolve Pullfrog-owned threads without duplicates
- the current PR source iteration has a review status suitable for policy gating
- stale iterations cannot overwrite the latest result

## 3. Interactive comments, review follow-ups, and ad-hoc triggers

### Goal

Support the interactive workflows Pullfrog provides on GitHub: responding to reviewer feedback and explicit Pullfrog-directed requests.

### Scope

- ingest new Azure Repos PR comments/review threads after the initial validation review
- identify Pullfrog-directed requests and thread replies
- provide conversation context to the agent
- allow safe replies and thread resolution
- define trigger transport: Service Hooks, pipeline invocation, polling, or a documented combination
- deduplicate events and make retries idempotent
- enforce actor/repository permissions equivalent to the GitHub path

### Done when

- a user can ask Pullfrog a follow-up question/action from an Azure Repos PR thread
- Pullfrog can address review feedback and reply in the originating thread
- duplicate/replayed events do not create duplicate runs or comments
- auth/permission model is documented and tested

## 4. Safe write path for commits, pushes, and PR updates

### Goal

Enable Pullfrog to modify code for Azure Repos workflows instead of remaining review-only.

### Scope

- provider-neutral checkout/ref handling for Azure PR source branches
- authenticated git push using short-lived/job-scoped credentials where possible
- create commits and push fixes without exposing repository credentials to the model process
- update/create Azure Repos pull requests where needed
- port Pullfrog push modes/permission gates
- protect against pushing to stale PR iterations or unexpected refs
- preserve the existing shell/git security boundary

### Done when

- an agent can safely commit and push a fix to an authorized Azure Repos branch
- stale-source and protected-branch cases fail closed
- repository credentials are never exposed to model/provider subprocesses
- behavior is covered by integration/security tests comparable to GitHub git-write tests

## 5. CI failure and merge-conflict autofix parity

### Goal

Port Pullfrog's GitHub CI-repair and merge-conflict automation to Azure Pipelines/Azure Repos.

### Scope

- discover Azure Pipeline runs/jobs for the current PR/source commit
- fetch failed step/job logs with bounded context and secret-safe redaction
- trigger repair runs against human PRs according to configuration
- detect merge conflicts/update failures in Azure Repos
- perform conflict-resolution/fix commits through the safe Azure write path
- rerun or requeue failed Azure Pipeline validation where authorized
- suppress loops and stop after bounded repair attempts

### Done when

- Pullfrog can identify a failing Azure PR validation build and attempt a bounded fix
- Pullfrog can resolve supported merge conflicts and update the source branch
- fixes use the same stale-run and credential-isolation guarantees as the write path
- loop/retry behavior is deterministic and tested

## 6. Work-item triage and repository-level task parity

### Goal

Cover the non-PR workflows that GitHub Pullfrog currently supports: issue triage and ad-hoc repository tasks.

Azure DevOps uses Boards work items rather than GitHub Issues, so this needs an explicit product mapping rather than API-name parity.

### Scope

- map supported GitHub issue/triage capabilities to Azure Boards work items
- read work-item title/body/comments/links and relevant repo context
- post comments and update allowed work-item fields/tags
- support Pullfrog-directed ad-hoc requests from work-item comments
- link related commits/PRs/work items where useful
- document GitHub issue features with no Azure equivalent
- share event deduplication/auth rules with interactive triggers

### Done when

- a configured Azure Boards work item can trigger a triage/ad-hoc Pullfrog run
- Pullfrog can comment/update only explicitly allowed fields
- platform differences are documented rather than silently dropped
- permission boundaries and retries are covered by tests

## 7. Console, configuration, secrets, and auth parity

### Goal

Provide a production setup/management path for Azure DevOps comparable to Pullfrog's GitHub console and configuration experience.

### Scope

- Azure organization/project/repository onboarding
- repository/account-scoped Pullfrog configuration
- model selection and provider credentials without manual YAML edits per repository
- Azure-specific permission diagnostics
- secret storage/rotation semantics comparable to GitHub installations
- short-lived or workload-identity auth where Azure DevOps supports it
- console visibility for Azure runs and configuration
- installation/uninstallation lifecycle and auditability

### Done when

- an Azure DevOps repository can be onboarded, configured, inspected, and removed through a supported flow
- secrets have explicit scope, rotation, and precedence semantics
- minimum Azure permissions are surfaced before a run fails
- GitHub and Azure configuration share one conceptual model where practical
