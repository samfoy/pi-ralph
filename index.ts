/**
 * Ralph Loop Extension for Pi
 *
 * Hat-based orchestration loops inspired by ralph-orchestrator.
 * Keeps the agent iterating through specialized hats until the task is done.
 *
 * Commands:
 *   /ralph [preset] [prompt]  - Start a loop (interactive if no args)
 *   /ralph stop               - Stop the current loop
 *   /ralph status             - Show loop status
 *   /ralph presets            - List available presets
 *   /plan [idea]              - Start a PDD planning session
 *
 * Presets loaded from:
 *   ~/.pi/agent/ralph/presets/*.yml   (user)
 *   .pi/ralph/presets/*.yml           (project)
 *   <extension>/presets/*.yml         (built-in)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";

import type { PresetConfig, LoopState } from "./lib.js";
import {
  parsePreset,
  loadPresetsFromDir,
  detectPublishedEvent,
  containsCompletionPromise,
  findHatForEvent,
  buildHatInjection,
} from "./lib.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessage(messages[i])) {
      return getAssistantText(messages[i] as AssistantMessage);
    }
  }
  return "";
}

// ── Config Loading ─────────────────────────────────────────────────────────

function resolveBuiltinPresetsDir(): string {
  // jiti sets __dirname; ESM uses import.meta.url
  try {
    if (typeof __dirname !== "undefined") return join(__dirname, "presets");
  } catch { /* ignore */ }
  try {
    return join(dirname(new URL(import.meta.url).pathname), "presets");
  } catch { /* ignore */ }
  return join(homedir(), ".pi", "agent", "extensions", "ralph", "presets");
}

function loadAllPresets(cwd: string): Record<string, PresetConfig> {
  const builtinDir = resolveBuiltinPresetsDir();
  const userDir = join(homedir(), ".pi", "agent", "ralph", "presets");
  const projectDir = join(cwd, ".pi", "ralph", "presets");

  const builtins = loadPresetsFromDir(builtinDir);
  const user = loadPresetsFromDir(userDir);
  const project = loadPresetsFromDir(projectDir);

  // Project overrides user overrides built-in
  return { ...builtins, ...user, ...project };
}

// ── Event Detection (wrappers over AgentMessage[]) ─────────────────────────

/**
 * Search ALL assistant messages for a published event, not just the last one.
 */
function detectPublishedEventFromMessages(messages: AgentMessage[], hat: import("./lib.js").HatConfig): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessage(messages[i])) {
      const text = getAssistantText(messages[i] as AssistantMessage);
      const event = detectPublishedEvent(text, hat);
      if (event) return event;
    }
  }
  return null;
}

/**
 * Check if any assistant message contains the completion promise.
 */
function containsCompletionPromiseInMessages(messages: AgentMessage[], promise: string): boolean {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessage(messages[i])) {
      texts.push(getAssistantText(messages[i] as AssistantMessage));
    }
  }
  return containsCompletionPromise(texts, promise);
}

// ── PDD Plan Prompt ────────────────────────────────────────────────────────

const PDD_PROMPT = `## Prompt-Driven Development (PDD)

Transform a rough idea into a detailed design with an implementation plan.

### Important Rules
- **User-driven flow:** Never proceed to the next step without explicit user confirmation.
- **Iterative:** The user can move between requirements and research at any time.
- **Record as you go:** Write findings to files in real time.
- **Planning only:** Produce planning artifacts. Do NOT implement code.

### Steps

**1. Create Project Structure**
Derive \`task_name\` as kebab-case from the idea. Create:
- \`specs/{task_name}/rough-idea.md\` — the provided idea
- \`specs/{task_name}/requirements.md\` — Q&A record (initially empty)
- \`specs/{task_name}/research/\` — directory for research notes

Gate: Wait for user confirmation before proceeding.

**2. Requirements Clarification**
Ask ONE question at a time to refine the idea:
- Scope, users, constraints, success criteria, edge cases, integrations
- Append each Q&A to requirements.md as you go
- Ask the user when requirements clarification is complete

Gate: Do not proceed until user confirms requirements are complete.

**3. Research**
Propose a research plan, then investigate:
- Technologies, libraries, existing code patterns
- Document findings in \`specs/{task_name}/research/\` as separate topic files
- Check in with user periodically

Gate: Do not proceed until user confirms research is sufficient.

**4. Iteration Checkpoint**
Summarize current state, then ask: Proceed to design? More requirements? More research?

**5. Create Detailed Design**
Write \`specs/{task_name}/design.md\` with:
- Overview, Detailed Requirements, Architecture (with Mermaid diagrams)
- Components/Interfaces, Data Models, Error Handling
- Acceptance Criteria (Given-When-Then format)
- Testing Strategy, Appendices

Gate: Wait for user approval of the design.

**6. Implementation Plan**
Write \`specs/{task_name}/plan.md\` — numbered incremental steps.
Each step: objective, implementation guidance, test requirements, demo description.
Core end-to-end functionality should be available as early as possible.

Gate: Wait for user approval of the plan.

**7. Summary**
Create \`specs/{task_name}/summary.md\` listing all artifacts and next steps.

**8. Offer Ralph Integration**
Ask if the user wants a PROMPT.md for autonomous implementation via:
\`/ralph code-assist\` or \`/ralph spec-driven\``;

// ── Extension ──────────────────────────────────────────────────────────────

export default function ralphExtension(pi: ExtensionAPI) {
  let presets: Record<string, PresetConfig> = {};
  let loopState: LoopState | null = null;
  let planModeActive = false;
  // Track whether the last agent turn was triggered by the loop orchestrator
  let loopTriggeredTurn = false;
  // Store newSession from command context for use in event handlers
  let storedNewSession: (() => Promise<{ cancelled: boolean }>) | null = null;

  function updateStatus(ctx: ExtensionContext) {
    if (loopState?.active && loopState.currentHatKey) {
      const hat = loopState.preset.hats[loopState.currentHatKey];
      const hatName = hat?.name || loopState.currentHatKey;
      const iter = `${loopState.iteration}/${loopState.preset.event_loop.max_iterations}`;
      ctx.ui.setStatus(
        "ralph",
        ctx.ui.theme.fg("accent", `🎩 ${hatName}`) + ctx.ui.theme.fg("muted", ` [${iter}]`),
      );

      // Widget showing hat history
      const lines: string[] = [];
      lines.push(ctx.ui.theme.fg("accent", `Ralph Loop: ${loopState.presetName}`));
      for (const h of loopState.history.slice(-6)) {
        const icon = h.hat === loopState.currentHatKey ? "▸" : " ";
        const name = loopState.preset.hats[h.hat]?.name || h.hat;
        lines.push(
          ctx.ui.theme.fg(h.hat === loopState.currentHatKey ? "accent" : "muted", `${icon} ${name}`) +
            ctx.ui.theme.fg("dim", ` ← ${h.event}`),
        );
      }
      ctx.ui.setWidget("ralph-loop", lines);
    } else if (planModeActive) {
      ctx.ui.setStatus("ralph", ctx.ui.theme.fg("warning", "📋 PDD Planning"));
      ctx.ui.setWidget("ralph-loop", undefined);
    } else {
      ctx.ui.setStatus("ralph", undefined);
      ctx.ui.setWidget("ralph-loop", undefined);
    }
  }

  function stopLoop(ctx: ExtensionContext, reason: string) {
    if (!loopState) return;
    const iterations = loopState.iteration;
    const elapsed = Math.round((Date.now() - loopState.startTime) / 1000);
    loopState.active = false;
    loopState = null;
    loopTriggeredTurn = false;
    updateStatus(ctx);
    ctx.ui.notify(`Ralph loop ended: ${reason} (${iterations} iterations, ${elapsed}s)`, "info");
  }

  function completeLoop(ctx: ExtensionContext) {
    stopLoop(ctx, "Task complete ✓");
  }

  function startLoop(presetName: string, prompt: string, ctx: ExtensionContext) {
    const preset = presets[presetName];
    if (!preset) {
      ctx.ui.notify(`Unknown preset: ${presetName}`, "error");
      return;
    }

    // Find starting hat
    const startEvent = preset.event_loop.starting_event;
    let startHatKey: string | null = null;

    if (startEvent) {
      startHatKey = findHatForEvent(startEvent, preset);
    }
    if (!startHatKey) {
      // Default to first hat
      startHatKey = Object.keys(preset.hats)[0] || null;
    }

    if (!startHatKey) {
      ctx.ui.notify("Preset has no hats defined", "error");
      return;
    }

    loopState = {
      presetName,
      preset,
      currentHatKey: startHatKey,
      iteration: 1,
      startTime: Date.now(),
      prompt,
      active: true,
      cwd: ctx.cwd,
      history: [{ hat: startHatKey, event: startEvent || "start", iteration: 1 }],
      activations: { [startHatKey]: 1 },
      steering: [],
    };

    // Capture newSession from command context for use in agent_end handler.
    // newSession is only available on ExtensionCommandContext (command handlers),
    // not on the base ExtensionContext (event handlers like agent_end).
    if ('newSession' in ctx) {
      storedNewSession = (ctx as any).newSession.bind(ctx);
    }

    // Create .ralph/ directory for scratchpad
    const ralphDir = `${ctx.cwd}/.ralph`;
    if (!existsSync(ralphDir)) {
      mkdirSync(ralphDir, { recursive: true });
    }
    // Initialize scratchpad
    writeFileSync(`${ralphDir}/scratchpad.md`, `# Ralph Scratchpad\n\nPreset: ${presetName}\nTask: ${prompt}\n\n---\n\n`);

    updateStatus(ctx);
    loopTriggeredTurn = true;

    const hatName = preset.hats[startHatKey].name;

    // Start a fresh session for the first hat
    const startNewSession = storedNewSession ?? (() => Promise.resolve({ cancelled: false }));
    startNewSession().then(() => {
      pi.sendUserMessage(
        `[Ralph Loop: ${presetName}] Starting with hat: ${hatName}\n\nTask: ${prompt}`,
      );
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("ralph", {
    description: "Start a Ralph orchestration loop",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["stop", "status", "steer", "presets"];
      const presetNames = Object.keys(presets);
      const all = [...subcommands, ...presetNames];
      const filtered = all.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args?.trim() || "";

      if (trimmed === "stop") {
        if (loopState?.active) {
          stopLoop(ctx, "Stopped by user");
        } else {
          ctx.ui.notify("No active loop", "info");
        }
        return;
      }

      if (trimmed === "status") {
        if (!loopState?.active) {
          ctx.ui.notify("No active loop", "info");
          return;
        }
        const hat = loopState.preset.hats[loopState.currentHatKey!];
        const elapsed = Math.round((Date.now() - loopState.startTime) / 1000);
        ctx.ui.notify(
          `Preset: ${loopState.presetName}\n` +
            `Hat: ${hat?.name || loopState.currentHatKey}\n` +
            `Iteration: ${loopState.iteration}/${loopState.preset.event_loop.max_iterations}\n` +
            `Elapsed: ${elapsed}s` +
            (loopState.steering.length > 0 ? `\nPending steering: ${loopState.steering.length}` : ""),
          "info",
        );
        return;
      }

      if (trimmed.startsWith("steer")) {
        if (!loopState?.active) {
          ctx.ui.notify("No active loop to steer", "warning");
          return;
        }
        let message = trimmed.slice(5).trim();
        if (!message) {
          const input = await ctx.ui.input("Steering message:");
          if (!input?.trim()) return;
          message = input.trim();
        }
        loopState.steering.push(message);
        ctx.ui.notify(
          `Steering queued (${loopState.steering.length} pending). Will be injected into the next hat.`,
          "info",
        );
        return;
      }

      if (trimmed === "presets") {
        const names = Object.keys(presets);
        if (names.length === 0) {
          ctx.ui.notify("No presets found", "info");
          return;
        }
        const list = names
          .map((n) => {
            const p = presets[n];
            const hatNames = Object.values(p.hats)
              .map((h) => h.name)
              .join(" → ");
            return `${n}: ${hatNames}`;
          })
          .join("\n");
        ctx.ui.notify(`Available presets:\n${list}`, "info");
        return;
      }

      if (loopState?.active) {
        ctx.ui.notify("A loop is already running. Use /ralph stop first.", "warning");
        return;
      }

      let presetName: string;
      let prompt: string;

      if (!trimmed) {
        // Interactive mode
        const presetNames = Object.keys(presets);
        if (presetNames.length === 0) {
          ctx.ui.notify("No presets found. Add .yml files to ~/.pi/agent/ralph/presets/", "warning");
          return;
        }
        const selected = await ctx.ui.select("Select preset:", presetNames);
        if (!selected) return;
        presetName = selected;

        const userPrompt = await ctx.ui.input("Task prompt:");
        if (!userPrompt?.trim()) return;
        prompt = userPrompt;
      } else {
        // Parse: first word might be a preset name
        const parts = trimmed.split(/\s+/);
        const firstWord = parts[0];

        if (presets[firstWord]) {
          presetName = firstWord;
          prompt = parts.slice(1).join(" ");
        } else {
          // Default to "feature" preset, entire args is prompt
          presetName = "feature";
          prompt = trimmed;
        }

        if (!prompt) {
          const userPrompt = await ctx.ui.input("Task prompt:");
          if (!userPrompt?.trim()) return;
          prompt = userPrompt;
        }
      }

      startLoop(presetName, prompt, ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "Start a PDD planning session (Prompt-Driven Development)",
    handler: async (args, ctx) => {
      if (loopState?.active) {
        ctx.ui.notify("A Ralph loop is running. Use /ralph stop first.", "warning");
        return;
      }

      let idea = args?.trim() || "";
      if (!idea) {
        const input = await ctx.ui.input("What's your rough idea?");
        if (!input?.trim()) return;
        idea = input;
      }

      planModeActive = true;
      updateStatus(ctx);
      pi.sendUserMessage(`${idea}`);
    },
  });

  // ── Event Handlers ─────────────────────────────────────────────────────

  // Inject hat instructions into system prompt
  pi.on("before_agent_start", async (event) => {
    if (planModeActive) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + PDD_PROMPT,
      };
    }

    if (!loopState?.active || !loopState.currentHatKey) return;

    const hat = loopState.preset.hats[loopState.currentHatKey];
    if (!hat) return;

    const injection = buildHatInjection(hat, loopState);

    // Clear steering after injection — it's been delivered
    loopState.steering = [];

    return {
      systemPrompt: event.systemPrompt + "\n\n" + injection,
    };
  });

  // Detect events and continue loop after agent finishes
  pi.on("agent_end", async (event, ctx) => {
    // Handle plan mode exit
    if (planModeActive) {
      // PDD is interactive, don't auto-continue. Just keep the prompt active.
      // User drives the flow manually.
      return;
    }

    if (!loopState?.active || !loopState.currentHatKey) return;

    // Only auto-continue if this turn was triggered by the loop
    if (!loopTriggeredTurn) {
      // User sent a manual message during the loop — treat as steering.
      // Next agent_end after a loop-triggered turn will continue.
      loopTriggeredTurn = true; // Re-arm for next turn
      return;
    }

    const output = getLastAssistantText(event.messages);
    const { preset } = loopState;

    // Check completion promise (scans all assistant messages)
    if (containsCompletionPromiseInMessages(event.messages, preset.event_loop.completion_promise)) {
      completeLoop(ctx);
      return;
    }
    // Also check legacy format in last message
    if (output.includes(preset.event_loop.completion_promise)) {
      completeLoop(ctx);
      return;
    }

    // Check max iterations
    if (loopState.iteration >= preset.event_loop.max_iterations) {
      stopLoop(ctx, `Max iterations reached (${preset.event_loop.max_iterations})`);
      return;
    }

    // Check max runtime
    if (preset.event_loop.max_runtime_seconds) {
      const elapsed = (Date.now() - loopState.startTime) / 1000;
      if (elapsed >= preset.event_loop.max_runtime_seconds) {
        stopLoop(ctx, `Max runtime reached (${preset.event_loop.max_runtime_seconds}s)`);
        return;
      }
    }

    // Detect published event (scans all assistant messages, not just the last)
    const currentHat = preset.hats[loopState.currentHatKey];
    const publishedEvent = detectPublishedEventFromMessages(event.messages, currentHat);

    if (!publishedEvent) {
      stopLoop(ctx, "No event published — loop stalled");
      return;
    }

    // Find next hat
    const nextHatKey = findHatForEvent(publishedEvent, preset);
    if (!nextHatKey) {
      // No hat handles this event — treat as loop completion.
      // Terminal hats (committer, verifier, etc.) publish events that no other
      // hat triggers on. This is the normal completion path when the model
      // publishes an event instead of outputting the completion promise.
      completeLoop(ctx);
      return;
    }

    // Check max_activations before advancing
    const nextHatConfig = preset.hats[nextHatKey];
    if (nextHatConfig.max_activations) {
      const count = (loopState.activations[nextHatKey] || 0) + 1;
      if (count > nextHatConfig.max_activations) {
        stopLoop(ctx, `Hat "${nextHatConfig.name}" exhausted (${nextHatConfig.max_activations} activations)`);
        return;
      }
    }

    // Advance loop
    loopState.currentHatKey = nextHatKey;
    loopState.iteration++;
    loopState.activations[nextHatKey] = (loopState.activations[nextHatKey] || 0) + 1;
    loopState.history.push({
      hat: nextHatKey,
      event: publishedEvent,
      iteration: loopState.iteration,
    });

    updateStatus(ctx);
    persistState();

    const nextHat = preset.hats[nextHatKey];
    loopTriggeredTurn = true;

    // Notify hat transition (forwarded to Slack by the bot)
    ctx.ui.notify(
      `Ralph loop [${loopState.iteration}/${preset.event_loop.max_iterations}]: ` +
        `${currentHat.name} → ${nextHat.name} (event: ${publishedEvent})`,
      "info",
    );

    // Fresh session per hat — context passes through the scratchpad file on disk.
    const newSessionFn = storedNewSession ?? (() => Promise.resolve({ cancelled: false }));
    newSessionFn().then(() => {
      pi.sendUserMessage(
        `[Ralph Loop — Iteration ${loopState!.iteration}/${preset.event_loop.max_iterations}]\n` +
          `Event: ${publishedEvent} → Hat: ${nextHat.name}\n\n` +
          `Task: ${loopState!.prompt}\n\n` +
          `Read the scratchpad at \`${loopState!.cwd}/.ralph/scratchpad.md\` for context from the previous hat.`,
      );
    });
  });

  // Persist loop state for session restore
  function persistState() {
    if (loopState?.active) {
      pi.appendEntry("ralph-loop-state", {
        presetName: loopState.presetName,
        currentHatKey: loopState.currentHatKey,
        iteration: loopState.iteration,
        startTime: loopState.startTime,
        prompt: loopState.prompt,
        history: loopState.history,
        steering: loopState.steering,
      });
    }
  }

  pi.on("turn_end", async () => {
    if (loopState?.active) persistState();
  });

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    presets = loadAllPresets(ctx.cwd);

    // Restore loop state from session
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "ralph-loop-state",
      )
      .pop() as { data?: any } | undefined;

    if (stateEntry?.data) {
      const d = stateEntry.data;
      const preset = presets[d.presetName];
      if (preset) {
        loopState = {
          presetName: d.presetName,
          preset,
          currentHatKey: d.currentHatKey,
          iteration: d.iteration,
          startTime: d.startTime,
          prompt: d.prompt,
          active: true,
          history: d.history || [],
          steering: d.steering || [],
        };
        loopTriggeredTurn = true;
      }
    }

    updateStatus(ctx);
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    if (loopState?.active) persistState();
  });
}
