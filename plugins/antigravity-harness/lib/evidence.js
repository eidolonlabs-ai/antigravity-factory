import fs from "node:fs";
import path from "node:path";
import { computeWorkspaceDigest } from "./verify.js";
import { loadFactoryPolicy, hash, within } from "./policy.js";
import { writeRecord } from "./records.js";

export function recordEvidence({
  cwd = process.cwd(),
  kind,
  status,
  summary,
  producer,
  artifacts = [],
  expectedSubjectDigest,
  expectedPolicyDigest,
}) {
  const root = fs.realpathSync(cwd),
    policy = loadFactoryPolicy(root);
  if (
    !["browser", "review"].includes(kind) ||
    !["PASS", "FAIL"].includes(status)
  )
    throw new Error(
      "Evidence requires kind browser|review and status PASS|FAIL",
    );
  if (
    typeof summary !== "string" ||
    !summary.trim() ||
    typeof producer !== "string" ||
    !producer.trim()
  )
    throw new Error("Evidence requires summary and producer");
  const subjectDigest = computeWorkspaceDigest(root);
  if (
    expectedSubjectDigest !== subjectDigest ||
    expectedPolicyDigest !== policy.policyDigest
  )
    throw new Error("Evidence subject or policy changed since inspection");
  const artifactPaths = artifacts.map((p) => {
    const full = fs.realpathSync(path.resolve(root, p));
    if (
      ![root, ...policy.verification.artifactRoots].some((r) =>
        within(r, full),
      ) ||
      !fs.statSync(full).isFile()
    )
      throw new Error(
        "Evidence artifact must be a file within an allowed root",
      );
    return { path: full, digest: hash(fs.readFileSync(full)) };
  });
  const record = {
    schemaVersion: 1,
    kind,
    status,
    summary,
    producer,
    artifacts: artifactPaths,
    subjectDigest,
    policyDigest: policy.policyDigest,
    workspaceIdentity: hash(root),
    timestamp: new Date().toISOString(),
  };
  if (
    computeWorkspaceDigest(root) !== subjectDigest ||
    loadFactoryPolicy(root).policyDigest !== policy.policyDigest
  )
    throw new Error("Workspace changed while recording evidence");
  writeRecord(root, `evidence-${kind}.json`, record);
  return record;
}
