import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import {
  parsePreset,
  loadPresetsFromDir,
  saveLoopRecord,
  loadLoopRecords,
  detectPublishedEvent,
  containsCompletionPromise,
  findHatForEvent,
  buildHatInjection,
  type HatConfig,
  type PresetConfig,
  type LoopState,
  type LoopRecord,
} from "./lib.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeHat(overrides: Partial<HatConfig> = {}): HatConfig {
  return {
    name: "Test Hat",
    description: "A test hat",
    triggers: ["start"],
    publishes: ["done", "blocked"],
    default_publishes: "done",
    instructions: "Do the thing.",
    ...overrides,
  };
}

function makePreset(overrides: Partial<PresetConfig> = {}): PresetConfig {
  return {
    event_loop: {
      starting_event: "start",
      completion_promise: "LOOP_COMPLETE",
      max_iterations: 50,
    },
    hats: {
      builder: makeHat({ triggers: ["start"], publishes: ["build.done"] }),
      reviewer: makeHat({
        name: "Reviewer",
        triggers: ["build.done"],
        publishes: ["review.passed", "review.failed"],
        default_publishes: "review.passed",
      }),
    },
    ...overrides,
  };
}

function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  const preset = makePreset();
  return {
    presetName: "test",
    preset,
    currentHatKey: "builder",
    iteration: 1,
    startTime: Date.now(),
    prompt: "Do something",
    active: true,
    cwd: "/tmp/test-project",
    history: [],
    activations: {},
    steering: [],
    iterationLogs: [],
    ...overrides,
  };
}

// ── parsePreset ────────────────────────────────────────────────────────────

describe("parsePreset", () => {
  it("returns null for missing hats", () => {
    expect(parsePreset({ event_loop: {} })).toBeNull();
  });

  it("returns null for missing event_loop", () => {
    expect(parsePreset({ hats: {} })).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parsePreset(null)).toBeNull();
    expect(parsePreset(undefined)).toBeNull();
  });

  it("parses a valid preset", () => {
    const raw = {
      event_loop: {
        starting_event: "build.start",
        completion_promise: "DONE",
        max_iterations: 10,
        max_runtime_seconds: 3600,
      },
      hats: {
        builder: {
          name: "Builder",
          description: "Builds things",
          triggers: ["build.start"],
          publishes: ["build.done"],
          default_publishes: "build.done",
          instructions: "Build it.",
          disallowed_tools: ["edit"],
          max_activations: 3,
        },
      },
      core: {
        specs_dir: "./specs/",
        guardrails: ["Tests must pass"],
      },
    };

    const result = parsePreset(raw)!;
    expect(result).not.toBeNull();
    expect(result.event_loop.starting_event).toBe("build.start");
    expect(result.event_loop.completion_promise).toBe("DONE");
    expect(result.event_loop.max_iterations).toBe(10);
    expect(result.event_loop.max_runtime_seconds).toBe(3600);
    expect(result.hats.builder.name).toBe("Builder");
    expect(result.hats.builder.triggers).toEqual(["build.start"]);
    expect(result.hats.builder.disallowed_tools).toEqual(["edit"]);
    expect(result.hats.builder.max_activations).toBe(3);
    expect(result.core?.guardrails).toEqual(["Tests must pass"]);
  });

  it("applies defaults for missing fields", () => {
    const raw = {
      event_loop: {},
      hats: {
        worker: { instructions: "Work." },
      },
    };

    const result = parsePreset(raw)!;
    expect(result.event_loop.completion_promise).toBe("LOOP_COMPLETE");
    expect(result.event_loop.max_iterations).toBe(50);
    expect(result.hats.worker.name).toBe("worker"); // falls back to key
    expect(result.hats.worker.triggers).toEqual([]);
    expect(result.hats.worker.publishes).toEqual([]);
  });
});

// ── detectPublishedEvent ───────────────────────────────────────────────────

describe("detectPublishedEvent", () => {
  const hat = makeHat({ publishes: ["build.done", "build.blocked"] });

  it("detects XML event tags", () => {
    const text = `I finished building.\n<event topic="build.done">All tests pass</event>`;
    expect(detectPublishedEvent(text, hat)).toBe("build.done");
  });

  it("uses last XML event when multiple present", () => {
    const text = `<event topic="build.blocked">Stuck</event>\nFixed it!\n<event topic="build.done">Done now</event>`;
    expect(detectPublishedEvent(text, hat)).toBe("build.done");
  });

  it("falls back to default_publishes for unknown XML event", () => {
    const text = `<event topic="unknown.event">Oops</event>`;
    expect(detectPublishedEvent(text, hat)).toBe("done");
  });

  it("detects legacy >>> EVENT: format", () => {
    const text = "All done.\n>>> EVENT: build.done";
    expect(detectPublishedEvent(text, hat)).toBe("build.done");
  });

  it("handles legacy format with trailing <<<", () => {
    const text = ">>> EVENT: build.done <<<";
    expect(detectPublishedEvent(text, hat)).toBe("build.done");
  });

  it("falls back to default_publishes for unknown legacy event", () => {
    const text = ">>> EVENT: something.weird";
    expect(detectPublishedEvent(text, hat)).toBe("done");
  });

  it("falls back to default_publishes when no event found", () => {
    const text = "I did some work but forgot to publish an event.";
    expect(detectPublishedEvent(text, hat)).toBe("done");
  });

  it("returns null when no event and no default", () => {
    const noDefaultHat = makeHat({ default_publishes: undefined });
    const text = "No event here.";
    expect(detectPublishedEvent(text, noDefaultHat)).toBeNull();
  });

  it("prefers XML over legacy when both present", () => {
    const text = `>>> EVENT: build.blocked\n<event topic="build.done">XML wins</event>`;
    expect(detectPublishedEvent(text, hat)).toBe("build.done");
  });

  it("is case-insensitive for legacy format prefix", () => {
    const text = ">>> event: build.done";
    expect(detectPublishedEvent(text, hat)).toBe("build.done");
  });
});

// ── containsCompletionPromise ──────────────────────────────────────────────

describe("containsCompletionPromise", () => {
  it("detects promise on its own line", () => {
    expect(containsCompletionPromise(["Some work\nLOOP_COMPLETE"], "LOOP_COMPLETE")).toBe(true);
  });

  it("detects promise with >>> prefix", () => {
    expect(containsCompletionPromise([">>> LOOP_COMPLETE"], "LOOP_COMPLETE")).toBe(true);
  });

  it("detects promise with trailing whitespace", () => {
    expect(containsCompletionPromise(["LOOP_COMPLETE  \n"], "LOOP_COMPLETE")).toBe(true);
  });

  it("ignores promise inside event tags", () => {
    const text = `<event topic="done">LOOP_COMPLETE</event>`;
    expect(containsCompletionPromise([text], "LOOP_COMPLETE")).toBe(false);
  });

  it("returns false when promise not present", () => {
    expect(containsCompletionPromise(["Just some text"], "LOOP_COMPLETE")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(containsCompletionPromise([], "LOOP_COMPLETE")).toBe(false);
  });

  it("checks only the last non-empty line per text block", () => {
    // Promise is NOT the last non-empty line
    const text = "LOOP_COMPLETE\nBut I kept going after that.";
    expect(containsCompletionPromise([text], "LOOP_COMPLETE")).toBe(false);
  });

  it("scans multiple text blocks", () => {
    expect(
      containsCompletionPromise(["first block", "second block\nLOOP_COMPLETE"], "LOOP_COMPLETE"),
    ).toBe(true);
  });

  it("works with custom promise strings", () => {
    expect(containsCompletionPromise(["DEBUG_COMPLETE"], "DEBUG_COMPLETE")).toBe(true);
    expect(containsCompletionPromise(["REFACTOR_COMPLETE"], "REFACTOR_COMPLETE")).toBe(true);
  });
});

// ── findHatForEvent ────────────────────────────────────────────────────────

describe("findHatForEvent", () => {
  const preset = makePreset();

  it("finds hat by trigger event", () => {
    expect(findHatForEvent("start", preset)).toBe("builder");
    expect(findHatForEvent("build.done", preset)).toBe("reviewer");
  });

  it("returns null for unknown event", () => {
    expect(findHatForEvent("nonexistent.event", preset)).toBeNull();
  });

  it("returns first matching hat when multiple could match", () => {
    const multi = makePreset({
      hats: {
        a: makeHat({ triggers: ["shared.event"] }),
        b: makeHat({ triggers: ["shared.event"] }),
      },
    });
    expect(findHatForEvent("shared.event", multi)).toBe("a");
  });
});

// ── buildHatInjection ──────────────────────────────────────────────────────

describe("buildHatInjection", () => {
  it("includes hat name and iteration", () => {
    const state = makeLoopState();
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("Hat: Test Hat");
    expect(result).toContain("Iteration 1/50");
  });

  it("includes hat instructions", () => {
    const state = makeLoopState();
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("Do the thing.");
  });

  it("includes guardrails when present", () => {
    const state = makeLoopState();
    state.preset.core = { guardrails: ["Tests must pass", "No hardcoded secrets"] };
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("### Guardrails");
    expect(result).toContain("Tests must pass");
    expect(result).toContain("No hardcoded secrets");
  });

  it("omits guardrails section when none defined", () => {
    const state = makeLoopState();
    state.preset.core = undefined;
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).not.toContain("### Guardrails");
  });

  it("includes tool restrictions when present", () => {
    const state = makeLoopState();
    const hat = makeHat({ disallowed_tools: ["edit", "write"] });
    const result = buildHatInjection(hat, state);
    expect(result).toContain("TOOL RESTRICTIONS");
    expect(result).toContain("**edit**");
    expect(result).toContain("**write**");
  });

  it("includes scratchpad path", () => {
    const state = makeLoopState({ cwd: "/my/project" });
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("/my/project/.ralph/scratchpad.md");
  });

  it("includes event protocol with publishable events", () => {
    const state = makeLoopState();
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("Event Protocol");
    expect(result).toContain("build.done");
  });

  it("includes completion promise", () => {
    const state = makeLoopState();
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("LOOP_COMPLETE");
  });

  it("includes steering when present", () => {
    const state = makeLoopState({
      steering: ["Skip the auth module", "Use postgres instead of sqlite"],
    });
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).toContain("### Steering from the User");
    expect(result).toContain("Skip the auth module");
    expect(result).toContain("Use postgres instead of sqlite");
  });

  it("omits steering section when empty", () => {
    const state = makeLoopState({ steering: [] });
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    expect(result).not.toContain("### Steering from the User");
  });

  it("places steering before event protocol", () => {
    const state = makeLoopState({ steering: ["Focus on error handling"] });
    const hat = state.preset.hats.builder;
    const result = buildHatInjection(hat, state);
    const steeringIdx = result.indexOf("### Steering from the User");
    const eventIdx = result.indexOf("### Event Protocol");
    expect(steeringIdx).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(steeringIdx);
  });
});

// ── loadPresetsFromDir ─────────────────────────────────────────────────────

describe("loadPresetsFromDir", () => {
  const tmpDir = join("/tmp", "ralph-test-presets-" + process.pid);

  function setup() {
    mkdirSync(tmpDir, { recursive: true });
  }

  function teardown() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns empty for nonexistent directory", () => {
    expect(loadPresetsFromDir("/tmp/does-not-exist-ralph-test")).toEqual({});
  });

  it("loads valid yml files", () => {
    setup();
    try {
      const content = `
event_loop:
  starting_event: "test.start"
  completion_promise: "TEST_DONE"
  max_iterations: 10
hats:
  worker:
    name: "Worker"
    triggers: ["test.start"]
    publishes: ["test.done"]
    instructions: "Work hard."
`;
      writeFileSync(join(tmpDir, "my-preset.yml"), content);
      const presets = loadPresetsFromDir(tmpDir);
      expect(Object.keys(presets)).toEqual(["my-preset"]);
      expect(presets["my-preset"].hats.worker.name).toBe("Worker");
      expect(presets["my-preset"].event_loop.completion_promise).toBe("TEST_DONE");
    } finally {
      teardown();
    }
  });

  it("skips non-yml files", () => {
    setup();
    try {
      writeFileSync(join(tmpDir, "readme.md"), "# Not a preset");
      writeFileSync(join(tmpDir, "config.json"), "{}");
      const presets = loadPresetsFromDir(tmpDir);
      expect(Object.keys(presets)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("skips yml files without hats or event_loop", () => {
    setup();
    try {
      writeFileSync(join(tmpDir, "bad.yml"), "name: not a preset\n");
      const presets = loadPresetsFromDir(tmpDir);
      expect(Object.keys(presets)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("handles .yaml extension", () => {
    setup();
    try {
      const content = `
event_loop:
  max_iterations: 5
hats:
  doer:
    triggers: ["go"]
    publishes: ["done"]
    instructions: "Do it."
`;
      writeFileSync(join(tmpDir, "alt.yaml"), content);
      const presets = loadPresetsFromDir(tmpDir);
      expect(Object.keys(presets)).toEqual(["alt"]);
    } finally {
      teardown();
    }
  });
});

// ── Loop Record helpers ────────────────────────────────────────────────────

function makeLoopRecord(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return {
    id: "123-test",
    presetName: "feature",
    prompt: "Add a widget",
    startTime: 1700000000000,
    endTime: 1700000060000,
    outcome: "Task complete ✓",
    iterations: 3,
    history: [{ hat: "builder", event: "start", iteration: 1 }],
    iterationLogs: [
      {
        iteration: 1,
        hatKey: "builder",
        hatName: "Builder",
        event: "build.done",
        summary: "Built the widget",
        timestamp: 1700000030000,
      },
    ],
    ...overrides,
  };
}

// ── saveLoopRecord / loadLoopRecords ───────────────────────────────────────

describe("saveLoopRecord", () => {
  const tmpDir = join("/tmp", "ralph-test-save-" + process.pid);

  function teardown() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("creates .ralph/loops/ and writes a JSON file", () => {
    try {
      const record = makeLoopRecord();
      const filePath = saveLoopRecord(tmpDir, record);
      expect(filePath).toContain(".ralph/loops/");
      expect(filePath).toContain("feature.json");
      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.presetName).toBe("feature");
      expect(content.prompt).toBe("Add a widget");
      expect(content.iterations).toBe(3);
    } finally {
      teardown();
    }
  });

  it("sanitizes preset name in filename", () => {
    try {
      const record = makeLoopRecord({ presetName: "my/weird preset!" });
      const filePath = saveLoopRecord(tmpDir, record);
      expect(filePath).not.toContain("/weird");
      expect(filePath).toContain("my_weird_preset_.json");
    } finally {
      teardown();
    }
  });

  it("writes pretty-printed JSON", () => {
    try {
      const record = makeLoopRecord();
      const filePath = saveLoopRecord(tmpDir, record);
      const raw = readFileSync(filePath, "utf-8");
      expect(raw).toContain("\n"); // multi-line = pretty-printed
      expect(raw).toContain("  "); // indented
    } finally {
      teardown();
    }
  });
});

describe("loadLoopRecords", () => {
  const tmpDir = join("/tmp", "ralph-test-load-" + process.pid);

  function teardown() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns empty array for nonexistent directory", () => {
    expect(loadLoopRecords("/tmp/does-not-exist-ralph-load")).toEqual([]);
  });

  it("loads and sorts records by startTime descending", () => {
    try {
      const older = makeLoopRecord({ startTime: 1700000000000, presetName: "older" });
      const newer = makeLoopRecord({ startTime: 1700000100000, presetName: "newer" });
      saveLoopRecord(tmpDir, older);
      saveLoopRecord(tmpDir, newer);

      const records = loadLoopRecords(tmpDir);
      expect(records.length).toBe(2);
      expect(records[0].presetName).toBe("newer");
      expect(records[1].presetName).toBe("older");
    } finally {
      teardown();
    }
  });

  it("skips non-JSON files", () => {
    try {
      saveLoopRecord(tmpDir, makeLoopRecord());
      writeFileSync(join(tmpDir, ".ralph", "loops", "readme.txt"), "not json");

      const records = loadLoopRecords(tmpDir);
      expect(records.length).toBe(1);
    } finally {
      teardown();
    }
  });

  it("skips invalid JSON files", () => {
    try {
      const loopsDir = join(tmpDir, ".ralph", "loops");
      mkdirSync(loopsDir, { recursive: true });
      writeFileSync(join(loopsDir, "bad.json"), "not valid json{{{");
      saveLoopRecord(tmpDir, makeLoopRecord());

      const records = loadLoopRecords(tmpDir);
      expect(records.length).toBe(1);
    } finally {
      teardown();
    }
  });

  it("skips JSON files missing required fields", () => {
    try {
      const loopsDir = join(tmpDir, ".ralph", "loops");
      mkdirSync(loopsDir, { recursive: true });
      writeFileSync(join(loopsDir, "empty.json"), JSON.stringify({ foo: "bar" }));
      saveLoopRecord(tmpDir, makeLoopRecord());

      const records = loadLoopRecords(tmpDir);
      expect(records.length).toBe(1);
    } finally {
      teardown();
    }
  });
});

// ── Built-in presets ───────────────────────────────────────────────────────

describe("built-in presets", () => {
  const presetsDir = join(__dirname, "presets");
  const presets = loadPresetsFromDir(presetsDir);

  it("loads all built-in presets", () => {
    const names = Object.keys(presets).sort();
    expect(names).toEqual(["code-assist", "debug", "feature", "iterate", "refactor", "review", "spec-driven"]);
  });

  for (const [name, preset] of Object.entries(presets)) {
    describe(`preset: ${name}`, () => {
      it("has a completion promise", () => {
        expect(preset.event_loop.completion_promise).toBeTruthy();
      });

      it("has max_iterations > 0", () => {
        expect(preset.event_loop.max_iterations).toBeGreaterThan(0);
      });

      it("has at least one hat", () => {
        expect(Object.keys(preset.hats).length).toBeGreaterThan(0);
      });

      it("has a reachable starting hat", () => {
        const startEvent = preset.event_loop.starting_event;
        if (startEvent) {
          const startHat = findHatForEvent(startEvent, preset);
          expect(startHat).not.toBeNull();
        } else {
          // No starting event — first hat is used
          expect(Object.keys(preset.hats).length).toBeGreaterThan(0);
        }
      });

      it("every hat has instructions", () => {
        for (const [key, hat] of Object.entries(preset.hats)) {
          expect(hat.instructions, `hat "${key}" missing instructions`).toBeTruthy();
        }
      });

      it("every hat has at least one trigger", () => {
        for (const [key, hat] of Object.entries(preset.hats)) {
          expect(hat.triggers.length, `hat "${key}" has no triggers`).toBeGreaterThan(0);
        }
      });

      it("every hat has at least one publishable event", () => {
        for (const [key, hat] of Object.entries(preset.hats)) {
          expect(hat.publishes.length, `hat "${key}" has no publishes`).toBeGreaterThan(0);
        }
      });

      it("published events are consumed or terminal", () => {
        // Every event a hat publishes must either:
        // 1. Trigger another hat, OR
        // 2. Match the completion promise
        // No dead-end events allowed.
        for (const hat of Object.values(preset.hats)) {
          for (const event of hat.publishes) {
            const consumer = findHatForEvent(event, preset);
            const isPromise = event === preset.event_loop.completion_promise;
            expect(
              consumer !== null || isPromise,
              `event "${event}" from hat "${hat.name}" has no consumer and is not the completion promise`,
            ).toBe(true);
          }
        }
      });

      it("at least one hat can output the completion promise", () => {
        // At least one hat's instructions must mention the completion promise
        // so the loop can terminate. Note: default_publishes does NOT prevent
        // termination — the completion promise is checked before event detection
        // in agent_end, so it always takes priority.
        const promise = preset.event_loop.completion_promise;
        const hasTerminator = Object.values(preset.hats).some(
          (hat) => hat.instructions.includes(promise),
        );
        expect(hasTerminator, `no hat mentions ${promise} in its instructions`).toBe(true);
      });

      it("has a loop-back path for multi-task work or terminates explicitly", () => {
        // Trace the happy path from starting hat to see if it can loop.
        // Either:
        // 1. Some hat publishes an event that triggers an earlier hat (loop-back), OR
        // 2. A hat can output the completion promise (explicit termination)
        const promise = preset.event_loop.completion_promise;
        const hatKeys = Object.keys(preset.hats);

        // Check: at least one hat can output the completion promise
        const hasTerminator = Object.values(preset.hats).some(
          (hat) => hat.instructions.includes(promise),
        );
        expect(hasTerminator, `no hat mentions ${promise} in its instructions`).toBe(true);

        // Check: if there are 3+ hats, there should be a loop-back event
        // (an event published by a later hat that triggers an earlier hat)
        if (hatKeys.length >= 3) {
          const hatOrder = new Map(hatKeys.map((k, i) => [k, i]));
          let hasLoopBack = false;
          for (const hat of Object.values(preset.hats)) {
            for (const event of hat.publishes) {
              const consumer = findHatForEvent(event, preset);
              if (consumer) {
                const publisherIdx = hatOrder.get(
                  hatKeys.find((k) => preset.hats[k] === hat)!,
                )!;
                const consumerIdx = hatOrder.get(consumer)!;
                if (consumerIdx <= publisherIdx) {
                  hasLoopBack = true;
                }
              }
            }
          }
          expect(
            hasLoopBack,
            "preset with 3+ hats should have a loop-back event for multi-task iteration",
          ).toBe(true);
        }
      });
    });
  }
});
