import { keccak256 } from "viem";
import artifact from "./contract.json" with { type: "json" };
import standard from "./standard.json" with { type: "json" };
import oldPractice from "./legacy/practice-240.json" with { type: "json" };
import oldStandard from "./legacy/standard-240.json" with { type: "json" };

export const artifacts = { practice: artifact, standard };
const revisions = {
  practice: [artifact, oldPractice],
  standard: [standard, oldStandard],
};

export function normalizedRuntime(code, reference = artifact) {
  const hex = code?.replace(/^0x/, "") || "";
  if (hex.length !== reference.runtime.replace(/^0x/, "").length) return null;
  const chars = hex.split("");
  for (const spans of Object.values(reference.immutableReferences))
    for (const { start, length } of spans)
      chars.fill("0", start * 2, (start + length) * 2);
  return `0x${chars.join("")}`;
}
export function matchesRuntime(code, reference = artifact) {
  const runtime = normalizedRuntime(code, reference);
  return Boolean(
    runtime &&
    keccak256(runtime) ===
      keccak256(normalizedRuntime(reference.runtime, reference)),
  );
}
export function detectMode(code) {
  return (
    Object.entries(revisions).find(([, versions]) =>
      versions.some((a) => matchesRuntime(code, a)),
    )?.[0] || null
  );
}
export function detectDuration(code, mode) {
  return matchesRuntime(code, artifacts[mode]) ? 60 : 240;
}
// Runtime alone cannot prove constructor-initialized state. Accept the exact direct deployment.
export function matchesCreation(transaction, mode) {
  const input = transaction?.input?.toLowerCase();
  return Boolean(
    transaction?.to == null &&
    input &&
    revisions[mode]?.some(
      (reference) =>
        input.length === reference.bytecode.length + 64 &&
        input.startsWith(reference.bytecode.toLowerCase()),
    ),
  );
}
