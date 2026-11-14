---
name: factory-qa-verifier
description: >-
  Run builds, linters, unit/integration tests, and live browser UI checks to
  verify factory output. Use after implementation slices are complete.
---

# Factory QA & Verifier

1. **Static & Build Checks**: Run the project's formatter, linter, type-checker, and build command.
2. **Automated Tests**: Run the relevant unit and integration test suites; never mark passing if any test is skipped or failing.
3. **Live UI / E2E Checks** (for web apps):
   - Start the local dev server as a background daemon if needed.
   - Delegate interactive UI verification (rendering, console errors, core user flows) to the `browser` subagent.
4. **Report**: Summarize exact commands run, pass/fail counts, and any failing output.
