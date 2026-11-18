# Antigravity compatibility

Qualified locally on 2026-11-17 with `agy 1.5.9`: native strict loader validation discovers four skills, one rule and two hooks without findings. Direct hook subprocess tests cover documentation-derived `model_stop` and legacy `NO_TOOL_CALL` payloads, background work, cancellation, errors, bounded continuations and fresh verification. Fixture payloads are not recordings of live sessions.

Native hooks run from the plugin root and use JSON decisions, not nonzero exit codes as blockers. Stop is a bounded reminder; errors in the host hook mechanism can fail open. Check the CLI status when mechanical completion is required.

Live authenticated host activation/continuation, nested GitHub URL discovery and Marketplace admission remain unqualified. The installed CLI exposes no documented profile-isolation flag; qualification must use a disposable authenticated environment without changing the developer's active plugin installation.

Supported repository route: clone the repository, then run `agy plugin install ./plugins/antigravity-harness` from that checkout. This is the documented local-directory route, not a claim that this nested repository installs directly by GitHub URL. Validate before installing. Native installation changes your Antigravity profile; project `init` is separate.

References: https://antigravity.google/docs/plugins/ ; https://antigravity.google/docs/build-plugins/ ; https://antigravity.google/docs/hooks/
