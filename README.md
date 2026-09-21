# Claude Code x Codex Plan Review

This repository is a proof of concept for an automated planning review loop:

1. Claude Code owns and revises the plan.
2. Codex independently reviews the plan against the requirement.
3. The loop stops at `APPROVED`, `NEEDS_HUMAN`, or the maximum review rounds.
4. Every run is stored as an audit trail and can be inspected with the read-only viewer.

## Repository layout

```text
agent-review-poc/
├── AGENTS.md
├── CLAUDE.md
├── review-loop.ps1
├── work-items/
│   └── tft-recorder/
│       ├── work-item.json
│       ├── REQUIREMENT.md
│       ├── PLAN.md              # generated working state
│       ├── REVIEW.md            # generated working state
│       ├── RESPONSE.md          # generated working state
│       └── history/
│           └── <run-id>/
└── viewer/
```

Each directory below `work-items/` is an isolated planning workspace. It has its own requirement, generated artifacts, sessions, and history.

## Prerequisites

- Git
- PowerShell 7 or Windows PowerShell 5.1+
- Node.js (only required for the viewer and the npm-based Codex installation)
- A Claude subscription or Anthropic Console account
- A ChatGPT plan that includes Codex, or an OpenAI API key

## Install Claude Code CLI

Official documentation: https://code.claude.com/docs

Windows PowerShell (recommended native installer):

```powershell
irm https://claude.ai/install.ps1 | iex
```

Alternative with WinGet:

```powershell
winget install Anthropic.ClaudeCode
```

macOS, Linux, or WSL:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Verify and sign in:

```powershell
claude --version
claude
```

Claude Code prompts for login on first use. An `ANTHROPIC_API_KEY` can also be supplied according to your organization's authentication policy.

## Install Codex CLI

Official documentation: https://developers.openai.com/codex/cli/

Install with npm:

```powershell
npm install -g @openai/codex
```

Verify and sign in:

```powershell
codex --version
codex
```

Follow the interactive sign-in flow. For API-key authentication, configure `OPENAI_API_KEY` according to your organization's policy.

## Create a work item

Create a lowercase kebab-case directory and add the two required files:

```text
work-items/my-feature/
├── work-item.json
└── REQUIREMENT.md
```

Example `work-item.json`:

```json
{
  "schemaVersion": 1,
  "id": "my-feature",
  "title": "My feature",
  "status": "DRAFT",
  "createdAt": "2026-09-21T10:00:00+08:00",
  "latestRunId": null
}
```

## Run a review

From the repository root:

```powershell
.\review-loop.ps1 -WorkItem tft-recorder
```

Optional overrides:

```powershell
.\review-loop.ps1 `
  -WorkItem tft-recorder `
  -MaxRevisionRounds 3 `
  -ClaudeModel sonnet `
  -CodexModel gpt-5.6-terra
```

The script validates the work-item ID, switches into that isolated workspace, creates fixed Claude and Codex session IDs for the run, and writes the audit trail to:

```text
work-items/<work-item-id>/history/<run-id>/
```

## Start the viewer

```powershell
cd viewer
npm start
```

Open http://127.0.0.1:4173. The viewer lists work items first, then the review runs belonging to the selected work item.

To use a different repository root:

```powershell
node server.js --root C:\path\to\agent-review-poc --port 4173
```

## Run results

| Status | Meaning |
|---|---|
| `APPROVED` | The plan is ready for human review. |
| `CHANGES_REQUESTED` | Claude must evaluate and respond to findings. |
| `NEEDS_HUMAN` | The agents found a decision that should not be made automatically. |
| `MAX_ROUNDS_REACHED` | The loop did not converge within the configured limit. |
| `FAILED` | A CLI, protocol, or artifact validation failed. |

## Troubleshooting

### Codex reports that the directory is not trusted

The script includes `--skip-git-repo-check` because work items may be executed from nested directories. Only run this repository and its requirements when you trust their contents.

### A stale review is reused

The script removes working `REVIEW.md` and `RESPONSE.md` files before asking an agent to recreate them. It also checks the CLI exit code and validates that the expected artifact exists.

### The wrong Codex session is resumed

The initial Codex JSONL event supplies the exact thread ID. The script stores it in `run.json` and resumes that ID directly; it does not use `--last`.

