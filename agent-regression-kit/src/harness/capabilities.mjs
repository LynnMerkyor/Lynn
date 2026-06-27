export const CAPABILITY_CATALOG = Object.freeze([
  {
    id: "turn.lifecycle",
    title: "Turn lifecycle",
    description: "A prompt is accepted, produces observable progress, and closes exactly once.",
    invariant: "No hanging turn, duplicate close, or silent empty success.",
    lanes: ["smoke", "release"],
  },
  {
    id: "context.isolation",
    title: "Context isolation",
    description: "Retry, edit, branch, and next-prompt flows do not leak stale targets or stale user text.",
    invariant: "A fresh prompt cannot inherit retry/edit metadata from an earlier turn.",
    lanes: ["release"],
  },
  {
    id: "provider.contract",
    title: "Provider contract",
    description: "The runtime can point at an injected model API or fake provider and expose request traces.",
    invariant: "Model API base URL, key env, model id, request body, and stream closure are inspectable.",
    lanes: ["smoke", "release"],
  },
  {
    id: "tool.trajectory",
    title: "Tool trajectory",
    description: "Tool selection, arguments, result handoff, and final answer behavior can be asserted.",
    invariant: "Tools are not simulated as prose when the runtime claims to execute them.",
    lanes: ["release", "nightly"],
  },
  {
    id: "failure.recovery",
    title: "Failure recovery",
    description: "Empty answers, timeouts, 4xx/5xx, tool failures, and malformed streams produce bounded outcomes.",
    invariant: "Failures must become a visible error, retry, fallback, or closed turn.",
    lanes: ["release"],
  },
  {
    id: "cli.surface",
    title: "CLI surface",
    description: "A headless prompt path can be driven and traced without a GUI.",
    invariant: "CLI output is parseable, bounded, and distinguishable from logs.",
    lanes: ["smoke", "release"],
  },
  {
    id: "gui.surface",
    title: "GUI surface",
    description: "A browser or Electron UI can send prompts, retry/edit, and display final state.",
    invariant: "User interactions emit the expected runtime payloads and visible state changes.",
    lanes: ["nightly"],
  },
  {
    id: "live.capability",
    title: "Live capability",
    description: "Injected live models are tested by structure and task outcome, not exact prose.",
    invariant: "Live tests never require a specific full natural-language answer.",
    lanes: ["nightly"],
  },
]);

export function inferCapabilityPlan(projectProfile) {
  const targets = new Set(projectProfile?.recommendedTargets || []);
  const technology = projectProfile?.technology || {};
  const plan = [
    capability("turn.lifecycle", "required"),
    capability("provider.contract", "required"),
    capability("context.isolation", "recommended"),
    capability("failure.recovery", "recommended"),
  ];
  if (targets.has("cli") || projectProfile?.package?.bin) plan.push(capability("cli.surface", "recommended"));
  if (targets.has("http")) plan.push(capability("tool.trajectory", "recommended"));
  if (targets.has("gui") || technology.electron || technology.react) plan.push(capability("gui.surface", "optional"));
  plan.push(capability("live.capability", "optional"));
  return dedupePlan(plan);
}

function capability(id, priority) {
  const entry = CAPABILITY_CATALOG.find((item) => item.id === id);
  return {
    id,
    priority,
    title: entry?.title || id,
    invariant: entry?.invariant || "",
    lanes: entry?.lanes || [],
  };
}

function dedupePlan(plan) {
  const seen = new Set();
  const out = [];
  for (const item of plan) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
