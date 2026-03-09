---
name: ralph-loop
description: Start a Ralph orchestration loop for multi-step tasks. Use when the user asks for feature implementation, TDD development, spec-driven work, refactoring, code review, debugging, or long-running iterative work that would benefit from autonomous hat-based orchestration.
---

# Ralph Loop

Ralph is a hat-based orchestration system that breaks complex tasks into phases (hats), each with specialized instructions. The loop runs autonomously, cycling through hats until the task is complete.

## When to Use Ralph

Start a Ralph loop when:
- The task has multiple implementation steps that benefit from plan → build → review → commit cycles
- The user asks for autonomous or hands-off implementation
- The work involves iterative refinement (TDD, spec verification, refactoring)
- The task involves long-running async steps (backtests, deployments, builds) with analysis between them
- The user explicitly mentions "ralph", "loop", or "orchestration"

Do NOT start a Ralph loop when:
- The task is a simple one-shot change (single file edit, quick fix)
- The user is asking a question or wants a conversation
- The user is already inside a Ralph loop

## Available Presets

| Preset | Flow | Best For |
|--------|------|----------|
| `feature` | Planner → Builder → Reviewer → Committer | General feature development with code review |
| `code-assist` | Planner → Builder → Validator → Committer | TDD-focused implementation (RED → GREEN → REFACTOR) |
| `spec-driven` | Spec Writer → Critic → Implementer → Verifier → Committer | When requirements need formal specification first |
| `refactor` | Refactorer → Verifier (loop) | Safe, incremental refactoring with verification |
| `iterate` | Iterator (self-loop) | Async iterative work — each turn does one step, scratchpad carries state |
| `review` | Code Reviewer → Deep Analyzer | Thorough code review without modifications |
| `debug` | Investigator → Hypothesis Tester → Bug Fixer → Fix Verifier | Scientific debugging with hypothesis testing |

## How to Start a Loop

Use the `start_ralph_loop` tool:

```
start_ralph_loop({ preset: "feature", prompt: "Add JWT authentication to the /users endpoint" })
```

### Choosing a Preset

- **Default to `feature`** for general implementation tasks
- Use `code-assist` when the user emphasizes testing or TDD
- Use `spec-driven` when requirements are ambiguous and need formal specification
- Use `refactor` for restructuring existing code with quick verification (edit → test → repeat)
- Use `iterate` for long-running iterative work where each step may involve async operations (backtests, deploys, builds). The single self-looping hat does one atomic step per turn, using the scratchpad as a state machine
- Use `review` when the user wants code reviewed without changes
- Use `debug` when tracking down a bug

### Choosing Between `refactor` and `iterate`

Use `refactor` when each step is atomic and verification is fast (run tests, check build). The refactorer→verifier handoff works well for code changes with immediate feedback.

Use `iterate` when steps involve long-running async work, analysis between runs, or the workflow doesn't fit a clean "change → verify" pattern. Examples: prompt tuning with backtests, performance optimization with benchmarks, iterative data analysis.

If the iterative workflow has well-defined phases (analyze → edit → wait → evaluate), consider a project-specific custom preset instead — see "Custom Presets" below.

### Writing a Good Prompt

The prompt is passed to every hat in the loop. Make it specific:
- Include what needs to be done
- Mention relevant files or modules if known
- Include constraints or requirements the user mentioned

## Custom Presets

Presets load from three locations (later overrides earlier):

1. **Built-in**: `<ralph>/presets/` — the standard presets
2. **User**: `~/.pi/agent/ralph/presets/` — personal presets across all projects
3. **Project**: `<cwd>/.pi/ralph/presets/` — project-specific presets

### When to Create a Custom Preset

Create a project-level preset when:
- The workflow has distinct phases that map to specialized hats
- A built-in preset's hat instructions don't match the task's grain
- The task involves domain-specific steps (e.g., backtest → evaluate → iterate)

### Self-Looping Hats

A hat can trigger on its own published event, creating a self-loop. This is useful for:
- Polling async jobs (check if done, yield if not)
- Open-ended iteration (the `iterate` preset's single hat)
- Retry loops (keep trying until a condition is met)

### Avoiding Long Single Turns

The hat handoff mechanism relies on `agent_end` firing between turns. If a hat's instructions encourage the model to chain many tool calls without stopping (e.g., "edit, build, run backtest, wait 30 minutes, analyze results"), the model will do everything in one turn and never hand off.

Design hat instructions so each hat's job naturally fits in one agent turn:
- ✅ "Analyze the results and write an edit plan" — bounded
- ✅ "Make the edit and kick off the build" — bounded
- ✅ "Wait for the backtest to finish, then capture results" — bounded (blocking is fine)
- ❌ "Edit the code, run the backtest, wait for results, analyze, decide next steps" — too many steps, will never yield
