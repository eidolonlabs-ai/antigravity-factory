---
name: factory-spec-planner
description: >-
  Turn a feature request or bug report into a structured technical spec with
  non-overlapping file ownership slices for parallel builders. Use during the
  planning stage of the software factory.
---

# Factory Spec & Architecture Planner

1. **Explore Read-Only**: Inspect the repository structure, existing patterns, and test setup (use the `research` subagent if the codebase is broad).
2. **Define Acceptance Criteria**: List concrete, testable outcomes for the feature or fix.
3. **Partition into Disjoint Slices**:
   - Group changes by module/file so **no two builders edit the same file**.
   - Define shared interfaces/contracts up front before builders start.
4. **Output Format**:
   - Summary of architecture & interface contracts
   - Numbered table of **Slices** (`Slice Name`, `Owned Files`, `Dependencies`, `Verification Command`)
