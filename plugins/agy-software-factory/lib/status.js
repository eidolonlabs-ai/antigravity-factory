import fs from "node:fs";
import { loadFactoryPolicy, hash, within } from "./policy.js";
import { computeWorkspaceDigest } from "./verify.js";
import { readRecord } from "./records.js";

export function evaluateStatus({
  cwd = process.cwd(),
  conversationId = null,
} = {}) {
  const root = fs.realpathSync(cwd),
    policy = loadFactoryPolicy(root),
    subjectDigest = computeWorkspaceDigest(root),
    workspaceIdentity = hash(root);
  const fresh = (r) =>
    r?.schemaVersion === 1 &&
    r.workspaceIdentity === workspaceIdentity &&
    r.subjectDigest === subjectDigest &&
    r.policyDigest === policy.policyDigest;
  const receipt = readRecord(root, "verify-receipt.json"),
    reasons = [];
  let outcome = "VERIFIED";
  if (!fresh(receipt)) {
    outcome = "UNVERIFIED";
    reasons.push("Verification receipt missing, legacy, or stale");
  } else if (receipt.ok !== true) {
    outcome = "FAILED";
    reasons.push("Deterministic verification failed");
  }
  const evidence = {};
  for (const kind of policy.verification.requiredEvidence) {
    const record = readRecord(root, `evidence-${kind}.json`);
    const artifactsValid =
      Array.isArray(record?.artifacts) &&
      record.artifacts.every((a) => {
        try {
          const p = fs.realpathSync(a.path);
          return (
            [root, ...policy.verification.artifactRoots].some((r) =>
              within(r, p),
            ) && hash(fs.readFileSync(p)) === a.digest
          );
        } catch {
          return false;
        }
      });
    // Command evidence is valid only for explicitly mapped policy commands in a fresh receipt.
    const commandChecks = policy.verification.commands
      .filter((c) => c.providesEvidence === kind)
      .map((c) => receipt?.checks?.find((x) => x.id === `custom:${c.id}`));
    const commandPass =
      fresh(receipt) &&
      receipt.ok === true &&
      commandChecks.length > 0 &&
      commandChecks.every((c) => c?.status === "PASS");
    if (
      fresh(record) &&
      artifactsValid &&
      ["PASS", "FAIL"].includes(record.status)
    ) {
      evidence[kind] = record.status;
      if (record.status === "FAIL") {
        outcome = "FAILED";
        reasons.push(`${kind} evidence failed`);
      }
    } else if (commandPass) evidence[kind] = "PASS";
    else {
      evidence[kind] = "MISSING_OR_STALE";
      if (outcome !== "FAILED") outcome = "UNVERIFIED";
      reasons.push(`${kind} evidence missing or stale`);
    }
  }
  const sessions = readRecord(root, "stop-gate-state.json")?.sessions ?? {};
  const sessionDiagnostics = Object.entries(sessions)
    .filter(([, s]) => s?.exhausted === true)
    .map(([id, s]) => ({
      conversationId: id,
      exhausted: true,
      updatedAt: s.updatedAt,
    }));
  if (
    outcome !== "VERIFIED" &&
    conversationId &&
    Object.hasOwn(sessions, conversationId) &&
    sessions[conversationId]?.exhausted === true
  )
    outcome = "EXHAUSTED";
  return {
    schemaVersion: 1,
    outcome,
    reasons,
    workspaceIdentity,
    subjectDigest,
    policyDigest: policy.policyDigest,
    requiredChecks: policy.verification.requiredChecks,
    evidence,
    sessionDiagnostics,
    receiptFresh: fresh(receipt),
  };
}
