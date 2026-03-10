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
}

// ── Preset Parsing ─────────────────────────────────────────────────────────

export function parsePreset(raw: any): PresetConfig | null {
  if (!raw?.hats || !raw?.event_loop) return null;

  const hats: Record<string, HatConfig> = {};
  for (const [key, val] of Object.entries(raw.hats)) {
    const h = val as any;
    hats[key] = {
      name: h.name || key,
      description: h.description || "",
      triggers: Array.isArray(h.triggers) ? h.triggers : [],
      publishes: Array.isArray(h.publishes) ? h.publishes : [],
      default_publishes: h.default_publishes || undefined,
      instructions: h.instructions || "",
      disallowed_tools: Array.isArray(h.disallowed_tools) ? h.disallowed_tools : undefined,
      max_activations: typeof h.max_activations === "number" ? h.max_activations : undefined,
    };
  }

  return {
    event_loop: {
      starting_event: raw.event_loop.starting_event,
      completion_promise: raw.event_loop.completion_promise || "LOOP_COMPLETE",
      max_iterations: raw.event_loop.max_iterations || 50,
      max_runtime_seconds: raw.event_loop.max_runtime_seconds,
    },
    hats,
    core: raw.core,
  };
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
      const raw = yaml.load(content) as any;
      if (!raw?.hats || !raw?.event_loop) continue;

      const preset = parsePreset(raw);
      if (preset) {
        const name = entry.replace(/\.ya?ml$/, "");
        presets[name] = preset;
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
export const XML_EVENT_PATTERN = /<event\s+topic="([^"]+)"[^>]*>([\s\S]*?)<\/event>/gi;

export function detectPublishedEvent(text: string, hat: HatConfig): string | null {
  // 1. XML-style event tags (preferred)
  const xmlMatches = [...text.matchAll(XML_EVENT_PATTERN)];
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
    const stripped = text.replace(/<event\s[^>]*>[\s\S]*?<\/event>/gi, "");
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

export function findHatForEvent(event: string, preset: PresetConfig): string | null {
  for (const [key, hat] of Object.entries(preset.hats)) {
    if (hat.triggers.includes(event)) return key;
  }
  return null;
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
