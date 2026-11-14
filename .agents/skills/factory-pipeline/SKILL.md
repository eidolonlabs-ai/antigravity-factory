---
name: factory-pipeline
description: >-
  Orchestrate an end-to-end multi-agent software factory workflow (Spec/Plan ->
  Parallel Builders -> QA Verification -> Security & Code Review) using
  Antigravity's native swarms, subagents, and skills. Use when the user asks to
  run the software factory or build a feature end-to-end.
---

# Antigravity Software Factory Pipeline

Run the following four-stage pipeline using Antigravity's built-in multi-agent features:

## Stage 1: Spec & Architecture Plan
1. Activate the `factory-spec-planner` skill (or invoke the `research` subagent for large codebases).
2. Break the request into **independent, non-overlapping slices** with explicit file ownership and acceptance criteria.
3. If requirements are ambiguous, ask clarifying questions (or recommend `/grill-me`).

## Stage 2: Parallel Build (Swarm)
1. Use Antigravity's native **swarm** (`/teamwork` / `swarm` tool) to spawn one builder worker per independent slice:
   - Give each author `workspace: "share"` so they can edit and build without colliding.
   - Give each worker a self-contained brief: owned files, forbidden files, and exact "done" criteria (including unit tests).
2. Add a `verifier` worker (`workspace: "inherit"`) to validate integrated changes once builders post their diffs.

## Stage 3: QA & Live Verification
1. Activate `factory-qa-verifier` to run the full build, linter, and test suite.
2. For web/UI apps, delegate live visual and interactive verification to the built-in `browser` subagent.

## Stage 4: Code & Security Review
1. Activate `factory-security-reviewer` (or a read-only swarm reviewer) to audit the final diff for bugs, edge cases, and security issues.
2. Fix any flagged blockers and re-run Stage 3 before presenting the final summary to the user.
