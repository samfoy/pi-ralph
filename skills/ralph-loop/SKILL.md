---
name: ralph-loop
description: Start a Ralph orchestration loop for multi-step tasks. Use when the user asks for feature implementation, TDD development, spec-driven work, refactoring, code review, or debugging that would benefit from autonomous hat-based orchestration with planning, building, reviewing, and committing phases.
---

# Ralph Loop

Ralph is a hat-based orchestration system that breaks complex tasks into phases (hats), each with specialized instructions. The loop runs autonomously, cycling through hats until the task is complete.

## When to Use Ralph

Start a Ralph loop when:
- The task has multiple implementation steps that benefit from plan → build → review → commit cycles
- The user asks for autonomous or hands-off implementation
- The work involves iterative refinement (TDD, spec verification, refactoring)
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
- Use `refactor` for restructuring existing code
- Use `review` when the user wants code reviewed without changes
- Use `debug` when tracking down a bug

### Writing a Good Prompt

The prompt is passed to every hat in the loop. Make it specific:
- Include what needs to be done
- Mention relevant files or modules if known
- Include constraints or requirements the user mentioned
