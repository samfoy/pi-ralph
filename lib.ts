/**
 * Pure logic extracted from index.ts for testability.
 * No pi API dependencies — just types, parsing, and event detection.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

// ── Types ──────────────────────────────────────────────────────────────────

export interface HatConfig {
  name: string;
  description: string;
  triggers: string[];
  publishes: string[];
  default_publishes?: string;
  instructions: string;
  disallowed_tools?: string[];
  max_activations?: number;
}

export interface EventLoopConfig {
  starting_event?: string;
  completion_promise: string;
  max_iterations: number;
  max_runtime_seconds?: number;
}

export interface PresetConfig {
  event_loop: EventLoopConfig;
  hats: Record<string, HatConfig>;
  core?: {
    specs_dir?: string;
    guardrails?: string[];
  };
}

export interface IterationLog {
  iteration: number;
  hatKey: string;
  hatName: string;
  event: string;
  summary: string;
  timestamp: number;
}

export interface LoopRecord {
  id: string;
  presetName: string;
  prompt: string;
  startTime: number;
  endTime: number;
  outcome: string;
  iterations: number;
  history: Array<{ hat: string; event: string; iteration: number }>;
  iterationLogs: IterationLog[];
}

export interface LoopState {
  presetName: string;
  preset: PresetConfig;
  currentHatKey: string | null;
  iteration: number;
  startTime: number;
  prompt: string;
  active: boolean;
  paused: boolean;
  cwd: string;
  history: Array<{ hat: string; event: string; iteration: number }>;
  activations: Record<string, number>;
  steering: string[];
  iterationLogs: IterationLog[];
  /** Whether the last agent turn was triggered by the loop orchestrator. */
  loopTriggeredTurn: boolean;
  /** When true, the next agent_end should skip event detection (loop just started). */
  pendingKickoff: boolean;
}

// ── Preset Parsing ─────────────────────────────────────────────────────────

/** Minimal shape we expect from raw YAML before parsing into PresetConfig. */
interface RawPreset {
  event_loop: {
    starting_event?: string;
    completion_promise?: string;
    max_iterations?: number;
    max_runtime_seconds?: number;
  };
  hats: Record<string, {
    name?: string;
    description?: string;
    triggers?: unknown;
    publishes?: unknown;
    default_publishes?: string;
    instructions?: string;
    disallowed_tools?: unknown;
    max_activations?: unknown;
  }>;
  core?: {
    specs_dir?: string;
    guardrails?: string[];
  };
}

function isRawPreset(raw: unknown): raw is RawPreset {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.hats === "object" && obj.hats !== null
    && typeof obj.event_loop === "object" && obj.event_loop !== null;
}

export function parsePreset(raw: unknown): PresetConfig | null {
  if (!isRawPreset(raw)) return null;

  const hats: Record<string, HatConfig> = {};
  for (const [key, h] of Object.entries(raw.hats)) {
    hats[key] = {
      name: h.name ?? key,
      description: h.description ?? "",
      triggers: Array.isArray(h.triggers) ? (h.triggers as string[]) : [],
      publishes: Array.isArray(h.publishes) ? (h.publishes as string[]) : [],
      default_publishes: h.default_publishes ?? undefined,
      instructions: h.instructions ?? "",
      disallowed_tools: Array.isArray(h.disallowed_tools) ? (h.disallowed_tools as string[]) : undefined,
      max_activations: typeof h.max_activations === "number" ? h.max_activations : undefined,
    };
  }

  return {
    event_loop: {
      starting_event: raw.event_loop.starting_event,
      completion_promise: raw.event_loop.completion_promise ?? "LOOP_COMPLETE",
      max_iterations: raw.event_loop.max_iterations ?? 50,
      max_runtime_seconds: raw.event_loop.max_runtime_seconds,
    },
    hats,
    core: raw.core,
  };
}

// ── Preset Validation ──────────────────────────────────────────────────────

export interface PresetValidationIssue {
  level: "error" | "warning";
  message: string;
}

/**
 * Validate a parsed preset's structural integrity. Returns a list of issues.
 *
 * Errors indicate the preset is unusable; warnings indicate potential problems
 * that won't prevent the loop from running but may cause unexpected behavior.
 *
 * Checks:
 * - Every hat has instructions (error)
 * - Every hat has at least one trigger (error)
 * - Every hat has at least one publishable event (error)
 * - Starting event has a reachable hat when defined (error)
 * - Published events are consumed by another hat or are terminal (warning)
 * - At least one hat mentions the completion promise in its instructions (warning)
 * - Loop-back path exists for presets with 3+ hats (warning)
 */
export function validatePreset(name: string, preset: PresetConfig): PresetValidationIssue[] {
  const issues: PresetValidationIssue[] = [];
  const hatKeys = Object.keys(preset.hats);

  // Basic hat checks
  for (const [key, hat] of Object.entries(preset.hats)) {
    if (!hat.instructions) {
      issues.push({ level: "error", message: `[${name}] hat "${key}" has no instructions` });
    }
    if (hat.triggers.length === 0) {
      issues.push({ level: "error", message: `[${name}] hat "${key}" has no triggers` });
    }
    if (hat.publishes.length === 0) {
      issues.push({ level: "error", message: `[${name}] hat "${key}" has no publishable events` });
    }
  }

  // Starting event reachability
  const startEvent = preset.event_loop.starting_event;
  if (startEvent) {
    const startHat = findHatForEvent(startEvent, preset);
    if (!startHat) {
      issues.push({
        level: "error",
        message: `[${name}] starting_event "${startEvent}" has no matching hat trigger`,
      });
    }
  }

  // Published events consumed or terminal
  for (const hat of Object.values(preset.hats)) {
    for (const event of hat.publishes) {
      const consumer = findHatForEvent(event, preset);
      const isPromise = event === preset.event_loop.completion_promise;
      if (!consumer && !isPromise) {
        issues.push({
          level: "warning",
          message: `[${name}] event "${event}" from hat "${hat.name}" has no consumer and is not the completion promise`,
        });
      }
    }
  }

  // At least one hat can output the completion promise
  const promise = preset.event_loop.completion_promise;
  const hasTerminator = Object.values(preset.hats).some(
    (hat) => hat.instructions.includes(promise),
  );
  if (!hasTerminator) {
    issues.push({
      level: "warning",
      message: `[${name}] no hat mentions "${promise}" in its instructions`,
    });
  }

  // Loop-back path for presets with 3+ hats
  if (hatKeys.length >= 3) {
    const hatOrder = new Map(hatKeys.map((k, i) => [k, i]));
    let hasLoopBack = false;
    for (const [hatKey, hat] of Object.entries(preset.hats)) {
      for (const event of hat.publishes) {
        const consumer = findHatForEvent(event, preset);
        if (consumer) {
          const publisherIdx = hatOrder.get(hatKey)!;
          const consumerIdx = hatOrder.get(consumer)!;
          if (consumerIdx <= publisherIdx) {
            hasLoopBack = true;
          }
        }
      }
    }
    if (!hasLoopBack) {
      issues.push({
        level: "warning",
        message: `[${name}] preset with 3+ hats has no loop-back event for multi-task iteration`,
      });
    }
  }

  return issues;
}

export function loadPresetsFromDir(dir: string): Record<string, PresetConfig> {
  const presets: Record<string, PresetConfig> = {};
  if (!existsSync(dir)) return presets;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return presets;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const filePath = join(dir, entry);
    try {
      const content = readFileSync(filePath, "utf-8");
      const raw: unknown = yaml.load(content);
      if (!isRawPreset(raw)) continue;

      const preset = parsePreset(raw);
      if (preset) {
        const name = entry.replace(/\.ya?ml$/, "");
        const issues = validatePreset(name, preset);
        const hasErrors = issues.some((i) => i.level === "error");
        if (!hasErrors) {
          presets[name] = preset;
        }
        // Warnings are silently accepted — callers can validate separately
      }
    } catch {
      // Skip invalid files
    }
  }
  return presets;
}

// ── Loop Records ───────────────────────────────────────────────────────────

export function saveLoopRecord(dir: string, record: LoopRecord): string {
  const loopsDir = join(dir, ".ralph", "loops");
  mkdirSync(loopsDir, { recursive: true });
  const ts = new Date(record.startTime).toISOString().replace(/[:.]/g, "-");
  const safeName = record.presetName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}-${safeName}.json`;
  const filePath = join(loopsDir, filename);
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadLoopRecords(dir: string): LoopRecord[] {
  const loopsDir = join(dir, ".ralph", "loops");
  if (!existsSync(loopsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(loopsDir);
  } catch {
    return [];
  }

  const records: LoopRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const content = readFileSync(join(loopsDir, entry), "utf-8");
      const record = JSON.parse(content) as LoopRecord;
      if (record.startTime && record.presetName) {
        records.push(record);
      }
    } catch {
      // Skip invalid files
    }
  }

  // Sort by startTime descending (newest first)
  records.sort((a, b) => b.startTime - a.startTime);
  return records;
}

// ── Event Detection ────────────────────────────────────────────────────────

export const EVENT_PATTERN = />>>\s*EVENT:\s*(\S+)/i;

/** Base pattern for XML event tags — use with `new RegExp(source, "gi")` for matchAll. */
export const XML_EVENT_PATTERN = /<event\s+topic="([^"]+)"[^>]*>([\s\S]*?)<\/event>/i;

export function detectPublishedEvent(text: string, hat: HatConfig): string | null {
  // 1. XML-style event tags (preferred) — use local regex to avoid global lastIndex state
  const xmlRegex = new RegExp(XML_EVENT_PATTERN.source, "gi");
  const xmlMatches = [...text.matchAll(xmlRegex)];
  if (xmlMatches.length > 0) {
    const lastMatch = xmlMatches[xmlMatches.length - 1];
    const topic = lastMatch[1];
    if (hat.publishes.includes(topic)) return topic;
    // Explicit event found but topic unrecognized — fall back to default
    return hat.default_publishes || null;
  }

  // 2. Explicit >>> EVENT: name (legacy format)
  const match = text.match(EVENT_PATTERN);
  if (match) {
    const eventName = match[1].replace(/\s*<<<?\s*$/, "");
    if (hat.publishes.includes(eventName)) return eventName;
    // Explicit event found but name unrecognized — fall back to default
    return hat.default_publishes || null;
  }

  // 3. No event pattern found in this text — return null so callers can
  //    check other messages before falling back to default_publishes.
  return null;
}

export function containsCompletionPromise(texts: string[], promise: string): boolean {
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i];
    // Strip event tags to avoid false positives
    const stripped = text.replace(new RegExp(XML_EVENT_PATTERN.source, "gi"), "");
    for (const line of stripped.split("\n").reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === promise) return true;
      if (trimmed === `>>> ${promise}`) return true;
      // Strip leading/trailing markdown formatting (bold, italic, code, heading) and re-check
      const bare = trimmed.replace(/^[*_`#\s]+|[*_`#\s]+$/g, "");
      if (bare === promise) return true;
      if (bare === `>>> ${promise}`) return true;
      break; // Only check the last non-empty line per text block
    }
  }
  return false;
}

// ── Stale Cycle Detection ──────────────────────────────────────────────────

/**
 * Detect when the loop is stuck in a repeating hat cycle with no progress.
 *
 * Tries all possible cycle lengths (2 up to a third of the history) and checks
 * whether the last THREE full cycles are identical hat:event sequences.
 * Requiring 3 repeats avoids false positives on normal multi-task work where
 * the same builder→reviewer→committer cycle runs for each task.
 */
export function detectStaleCycle(
  history: Array<{ hat: string; event: string; iteration: number }>,
): boolean {
  if (history.length < 6) return false;

  const keys = history.map((h) => `${h.hat}:${h.event}`);
  const minRepeats = 3;
  const maxCycleLen = Math.floor(keys.length / minRepeats);

  for (let cycleLen = 2; cycleLen <= maxCycleLen; cycleLen++) {
    const cycle = keys.slice(-cycleLen);
    let repeats = 1;

    for (let r = 2; r <= minRepeats; r++) {
      const start = keys.length - r * cycleLen;
      if (start < 0) break;
      const prev = keys.slice(start, start + cycleLen);
      if (prev.every((k, i) => k === cycle[i])) {
        repeats++;
      } else {
        break;
      }
    }

    if (repeats >= minRepeats) return true;
  }

  return false;
}

// ── Content-based Event Inference (safety net) ─────────────────────────────

/**
 * Safety-net heuristic for inferring the correct event when a hat has multiple
 * publishable events and the LLM forgot to emit an explicit event tag.
 *
 * **Review-oriented by default:** The keyword patterns (approve/reject) were
 * designed for code review hats, but the function also inspects event names for
 * semantic keywords (e.g., "fail", "reject", "rollback" vs "approve", "success",
 * "pass") to work with non-review hats like deploy or verify.
 *
 * This is a keyword-based heuristic — a safety net, not a replacement for the
 * event tag system. Only applies when a hat publishes >1 event.
 *
 * Returns null if no strong signal is found (caller should fall back to default).
 */
export function inferEventFromContent(text: string, hat: HatConfig): string | null {
  // Only useful when the hat can publish multiple events
  if (hat.publishes.length <= 1) return null;

  const lower = text.toLowerCase();

  // Patterns that signal rejection / changes requested
  const rejectPatterns = [
    "needs fix",
    "changes requested",
    "push back",
    "not approved",
    "sending back to builder",
    "fix required",
    "issues found",
    "requesting changes",
    "must be fixed",
    "needs to be fixed",
    "needs correction",
    "does not pass",
    "failed review",
    "review failed",
    "sending back for fixes",
    "cannot approve",
  ];

  // Patterns that signal approval
  const approvePatterns = [
    "lgtm",
    "looks good to me",
    "looks good",
    "approved",
    "all checks pass",
    "ship it",
    "ready to commit",
    "ready to merge",
    "no issues found",
    "passes review",
    "review passed",
  ];

  const hasRejectSignal = rejectPatterns.some((p) => lower.includes(p));
  const hasApproveSignal = approvePatterns.some((p) => lower.includes(p));

  // Semantic keywords in event names — maps events to negative/positive buckets.
  // This makes inference work for non-review hats (e.g., deploy.rollback vs deploy.success).
  const negativeEventKeywords = ["reject", "fail", "change", "request", "block", "rollback", "error"];
  const positiveEventKeywords = ["approve", "pass", "success", "ready", "complete"];

  /** Find the event whose name best matches the given keyword set, or null. */
  function findEventByKeywords(keywords: string[]): string | null {
    for (const event of hat.publishes) {
      const eventLower = event.toLowerCase();
      if (keywords.some((kw) => eventLower.includes(kw))) return event;
    }
    return null;
  }

  // Reject signals take priority — a false approval (skipping the fix cycle)
  // is more dangerous than a false rejection (an extra builder iteration)
  if (hasRejectSignal) {
    // Try to find a negative-sounding event by name first
    const negativeEvent = findEventByKeywords(negativeEventKeywords);
    if (negativeEvent) return negativeEvent;
    // Fall back to picking the non-default event
    const nonDefault = hat.publishes.find((e) => e !== hat.default_publishes);
    return nonDefault ?? null;
  }

  if (hasApproveSignal) {
    // Try to find a positive-sounding event by name first
    const positiveEvent = findEventByKeywords(positiveEventKeywords);
    if (positiveEvent) return positiveEvent;
    // The "positive" path — return default_publishes if it exists, else first event
    return hat.default_publishes ?? hat.publishes[0] ?? null;
  }

  // No strong signal
  return null;
}

export function findHatForEvent(event: string, preset: PresetConfig): string | null {
  for (const [key, hat] of Object.entries(preset.hats)) {
    if (hat.triggers.includes(event)) return key;
  }
  return null;
}

// ── Loop Orchestration Decision ────────────────────────────────────────────

/** Action returned by determineNextAction — the pure decision from agent_end. */
export type LoopAction =
  | { type: "complete" }
  | { type: "stop"; reason: string }
  | { type: "continue"; nextHatKey: string; event: string }
  | { type: "skip"; reason: string };

/** Input context for the orchestration decision — all data needed, no pi API deps. */
export interface LoopDecisionContext {
  /** Whether the completion promise was found in any assistant message. */
  completionPromiseFound: boolean;
  /** The event detected from assistant messages (null if none). */
  publishedEvent: string | null;
  /** Whether this turn was triggered by the loop (vs. a user message). */
  loopTriggeredTurn: boolean;
  /** Whether the loop is paused. */
  paused: boolean;
  /** Whether the loop was just started and this turn should be skipped. */
  pendingKickoff: boolean;
  /** Current iteration number. */
  iteration: number;
  /** Loop start time (epoch ms). */
  startTime: number;
  /** Current time (epoch ms) — injected for testability. */
  now: number;
  /** The preset config. */
  preset: PresetConfig;
  /** Current hat key. */
  currentHatKey: string;
  /** Full hat transition history. */
  history: Array<{ hat: string; event: string; iteration: number }>;
  /** Activation counts per hat key. */
  activations: Record<string, number>;
}

/**
 * Pure decision function: given the loop state after an agent turn, determine
 * the next action. This is the core orchestration logic extracted from the
 * agent_end event handler for testability.
 *
 * Returns one of:
 * - `{ type: "skip" }` — do nothing (user turn, paused, pending kickoff)
 * - `{ type: "complete" }` — loop is done
 * - `{ type: "stop", reason }` — stop with an error/limit reason
 * - `{ type: "continue", nextHatKey, event }` — transition to the next hat
 */
export function determineNextAction(ctx: LoopDecisionContext): LoopAction {
  // Skip: not a loop-triggered turn (user message during loop)
  if (!ctx.loopTriggeredTurn) {
    return { type: "skip", reason: "user-turn" };
  }

  // Skip: loop is paused
  if (ctx.paused) {
    return { type: "skip", reason: "paused" };
  }

  // Skip: pending kickoff (loop just started, this turn is the command/tool response)
  if (ctx.pendingKickoff) {
    return { type: "skip", reason: "pending-kickoff" };
  }

  // Complete: completion promise found
  if (ctx.completionPromiseFound) {
    return { type: "complete" };
  }

  // Stop: max iterations
  if (ctx.iteration >= ctx.preset.event_loop.max_iterations) {
    return { type: "stop", reason: `Max iterations reached (${ctx.preset.event_loop.max_iterations})` };
  }

  // Stop: max runtime
  if (ctx.preset.event_loop.max_runtime_seconds) {
    const elapsed = (ctx.now - ctx.startTime) / 1000;
    if (elapsed >= ctx.preset.event_loop.max_runtime_seconds) {
      return { type: "stop", reason: `Max runtime reached (${ctx.preset.event_loop.max_runtime_seconds}s)` };
    }
  }

  // Stop: no event published (stalled)
  if (!ctx.publishedEvent) {
    return { type: "stop", reason: "No event published — loop stalled" };
  }

  // Find next hat for the event
  const nextHatKey = findHatForEvent(ctx.publishedEvent, ctx.preset);
  if (!nextHatKey) {
    // No hat handles this event — treat as completion (terminal event)
    return { type: "complete" };
  }

  // Stop: max_activations exhausted for the next hat
  const nextHatConfig = ctx.preset.hats[nextHatKey];
  if (nextHatConfig.max_activations) {
    const count = (ctx.activations[nextHatKey] ?? 0) + 1;
    if (count > nextHatConfig.max_activations) {
      return {
        type: "stop",
        reason: `Hat "${nextHatConfig.name}" exhausted (${nextHatConfig.max_activations} activations)`,
      };
    }
  }

  // Complete: stale cycle detected
  const tentativeHistory = [
    ...ctx.history,
    { hat: nextHatKey, event: ctx.publishedEvent, iteration: ctx.iteration + 1 },
  ];
  if (detectStaleCycle(tentativeHistory)) {
    return { type: "complete" };
  }

  // Continue to next hat
  return { type: "continue", nextHatKey, event: ctx.publishedEvent };
}

// ── Hat Injection ──────────────────────────────────────────────────────────

export function buildHatInjection(hat: HatConfig, state: LoopState): string {
  const { preset } = state;
  const eventList = hat.publishes.map((e) => `  - ${e}`).join("\n");
  const scratchpadPath = `${state.cwd}/.ralph/scratchpad.md`;

  let injection = `\n## Ralph Orchestration — Hat: ${hat.name}\n`;
  injection += `Iteration ${state.iteration}/${preset.event_loop.max_iterations}\n\n`;
  injection += hat.instructions;

  if (preset.core?.guardrails?.length) {
    injection += "\n\n### Guardrails\n";
    for (const g of preset.core.guardrails) {
      injection += `- ${g}\n`;
    }
  }

  if (hat.disallowed_tools?.length) {
    injection += "\n\n### TOOL RESTRICTIONS\n";
    injection += "You MUST NOT use these tools in this hat:\n";
    for (const tool of hat.disallowed_tools) {
      injection += `- **${tool}** — blocked for this hat\n`;
    }
    injection += "\nUsing a restricted tool is a scope violation.\n";
  }

  injection += `\n\n### Scratchpad\n`;
  injection += `Each hat runs in a fresh session with no conversation history from previous hats.\n`;
  injection += `Use the scratchpad file to pass context between hats:\n\n`;
  injection += `**File:** \`${scratchpadPath}\`\n\n`;
  injection += `- **Read it first** — the previous hat's notes are there\n`;
  injection += `- **Write your notes** before publishing your event — the next hat will read them\n`;
  injection += `- Include: what you did, what files you changed, any issues found, what the next hat needs to know\n`;

  if (state.steering.length > 0) {
    injection += `\n\n### Steering from the User\n`;
    injection += `The user has provided the following guidance for this hat. Follow these instructions:\n\n`;
    for (const msg of state.steering) {
      injection += `- ${msg}\n`;
    }
  }

  injection += `\n\n### Event Protocol\n`;
  injection += `When you have completed ALL work for this hat, publish exactly ONE event using this XML format:\n\n`;
  injection += `\`\`\`\n<event topic="event_name">Brief description of what was done</event>\n\`\`\`\n\n`;
  injection += `You MUST use one of these EXACT event names (no other names are valid):\n${eventList}\n\n`;
  injection += `**CRITICAL:** The event tag signals the END of your work for this hat. `;
  injection += `Do ALL your work FIRST (implementation, tests, verification), THEN publish the event as your FINAL output. `;
  injection += `Do NOT continue working after publishing an event.\n\n`;
  injection += `When the ENTIRE task is fully complete (all work done, committed, and verified), instead output on its own line:\n`;
  injection += `${preset.event_loop.completion_promise}\n\n`;
  injection += `Do NOT output ${preset.event_loop.completion_promise} unless ALL work is truly finished.\n`;

  return injection;
}
