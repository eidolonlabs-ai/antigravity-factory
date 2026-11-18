---
name: factory-setup
description: >-
  Phase 0 workspace setup for Antigravity Factory. Initializes plugin links/copies,
  runs `agy-factory detect`, configures `.factory.json` verification policy and
  opt-in Stop hooks, sets up context hygiene logging, and establishes a baseline.
  Use before starting intake or onboarding an existing repository.
---

# Factory Setup (Phase 0)

Adopt a new or existing repository cleanly without overwriting existing developer configurations.

## Step 1: Locate `agy-factory` & Detect Stack

Resolve `FACTORY_CLI` (`node ./bin/agy-factory.js`, `node ./.agents/plugins/antigravity-factory/bin/agy-factory.js`, or `node <plugin-dir>/bin/agy-factory.js`) and inspect the workspace:

```bash
$FACTORY_CLI detect --cwd . --json
```

## Step 2: Initialize Plugin & Policy

If `.factory.json` or `.agents/plugins.json` is missing (avoiding duplicate registration if `antigravity-factory` is already installed globally via `agy plugin install`):

```bash
# Preview or initialize in an external project:
$FACTORY_CLI init . --mode copy   # or --mode link for local plugin dev
```

Review `.factory.json`:
- Set `"requireTests": true` so `NOT_RUN` test checks never pass silently.
- Optionally enable bounded stop reminders (`"enforceStopVerify": true` and `"stop": { "mode": "remind", "maxContinuations": 1 }`) and `verification.requiredChecks` / `verification.requiredEvidence` (`["review"]` or `["browser", "review"]`).
- Ensure `.factory/` and `.env` are listed in `.gitignore`.

## Step 3: Execution Policy & Context Hygiene

1. **Execution Mode**: Use `Shift + Tab` (`auto`) in Antigravity CLI or Desktop `Auto/Turbo` terminal policy inside isolated worktrees to eliminate approval-prompt stalls, keeping `pre-tool-guard.js` active for secrets, `.git/` internals, holdout tests, and slice boundaries.
2. **Context Hygiene**: Route verbose container builds and test runs to `/tmp/*.log` (`cmd > /tmp/run.log 2>&1 || (tail -n 50 /tmp/run.log && exit 1)`) so large logs never bloat the agent context window.
3. **Baseline Check**: On existing repositories, run `$FACTORY_CLI verify --cwd .` and record any preexisting failures before starting Phase 1.
