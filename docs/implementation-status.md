# Local factory implementation status

Implemented against the 2026-11-17 approved design in `docs/superpowers/`:

- Versioned policy, required checks/custom commands, evidence recording with preinspection digests, and read-only aggregate status.
- Shared fail-closed file/index snapshots; staged content, large files, symlinks and committed HEAD changes invalidate receipts.
- Native modern/legacy stop payload support and bounded conversation budgets with incomplete outcomes.
- Conflict-aware landing, worker and integrated verification, locking, compare-before-restore rollback and recovery guidance.
- Non-destructive copy upgrades, malformed/symlink registration rejection, a standalone archive/checksum inventory and extracted read-only smoke tests.
- Example-only real PostgreSQL integration and Chromium browser acceptance, failure signals and ephemeral-stack cleanup. A PostgreSQL idle-error crash discovered by acceptance testing was corrected.
- Native-first workflow documentation, plugin-local README/license/metadata and build-only release-candidate CI.

## Local validation — 2026-11-17

Independent reviews covered verification freshness and the final code/security diff. Review findings were reproduced and fixed, including staged-content freshness, copy-upgrade recovery, and landing failure diagnostics.

| Gate | Observed result |
| --- | --- |
| `npm test` | 68 passed; zero failed, skipped or cancelled |
| Root `verify --require-tests` | PASS: 2 PASS, 0 FAIL, 4 NOT_RUN |
| Task Tracker `verify --require-tests` | PASS: 5 PASS, 0 FAIL, 6 NOT_RUN; required API tests, web build and live-stack command passed |
| Real full-stack acceptance | PostgreSQL-backed API integration, two Chromium browser tests and database-outage handling passed |
| `audit-diff` | APPROVE_CANDIDATE with zero findings |
| Independent semantic/security review | Findings resolved and affected regression tests passed |
| Extracted read-only bundle smoke | Packaged CLI, copy installation and hook subprocesses passed |
| Native strict validation | Antigravity 1.5.9 (2026-11-17 baseline): four skills, one rule, two hooks; zero findings (current bundle expands skills to 8 unified `factory-*` stages + 3 `roles/` profiles) |

NOT_RUN entries represent unconfigured optional checks; they are not passes. Both workspaces reported VERIFIED with fresh receipts after validation. Receipts are local generated records, not committed attestations: staging, committing, or editing changes the verification subject and requires verification again. These results describe local checks, not GitHub Actions or authenticated host-session qualification.

## Reproduce the checks

From the repository root, run:

```sh
npm test
node bin/agy-factory.js verify --require-tests
node bin/agy-factory.js audit-diff
node bin/agy-factory.js verify --cwd examples/task-tracker --require-tests
npm run package:plugin
node scripts/smoke-plugin.js dist/antigravity-factory-1.1.0.tgz --native
```

The example requires Docker, its installed API/web dependencies and Playwright Chromium; see the [example setup](../examples/task-tracker/README.md). Native bundle qualification requires `agy`. The [release guide](release.md) explains installation and the remaining distribution checks.

## Qualification boundaries

Native loader validation passed with local Antigravity CLI 1.5.9. Hook subprocess fixtures are documentation-derived, not authenticated live-session recordings. This execution did not install into the developer's active profile, run a paid host agent, qualify direct GitHub nested-bundle discovery, inspect Marketplace logo presentation, publish a release, or submit to Marketplace. Those distribution qualifications remain explicit release checklist items. Clone plus native local-directory installation is documented from official support, not claimed as exercised against this user's profile.

The plugin is a cooperative local factory, not an OS sandbox or a sealed evaluator. Symlink target text is bound; external content reached through links requires separate verification. Submodules need separate component verification. VERIFIED covers configured requirements; independent review remains a workflow requirement even when evidence is not required mechanically. Rollback does not undo arbitrary test-command side effects.
