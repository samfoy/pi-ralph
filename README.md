# Ralph

A [pi](https://github.com/mariozechner/pi-coding-agent) extension for hat-based multi-agent orchestration loops. Ralph keeps the agent iterating through specialized "hats" (roles) until a task is complete — each hat has its own instructions, triggers, and events that drive the workflow forward.

## Features

- **Hat-based orchestration** — define specialized roles (Planner, Builder, Reviewer, etc.) that hand off work via events
- **Built-in presets** — ready-to-use workflows for common tasks
- **Custom presets** — create your own YAML-based workflows
- **PDD planning** — Prompt-Driven Development mode for turning rough ideas into detailed designs
- **Event protocol** — hats publish events that trigger the next hat, forming an autonomous loop
- **Guard rails** — max iterations, max runtime, and completion promises prevent runaway loops
- **Session persistence** — loop state survives session restarts

## Installation

Clone into your pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/samfoy/pi-ralph.git
cd ralph
npm install
```

pi will automatically discover and load the extension on next start.

## Built-in Presets

| Preset | Hats | Description |
|---|---|---|
| **feature** | Builder → Reviewer | General feature development with quality review |
| **code-assist** | Planner → Builder → Validator → Committer | Full TDD pipeline with planning and conventional commits |
| **spec-driven** | Spec Writer → Critic → Implementer → Verifier | Specification-first development |
| **debug** | Investigator → Tester → Fixer → Verifier | Scientific debugging with hypothesis testing |
| **refactor** | Refactorer → Verifier | Safe refactoring with verification at each step |
| **review** | Reviewer → Deep Analyzer | Code review with deep analysis |

## Usage

### Commands

```
/ralph [preset] [prompt]   Start a loop (interactive picker if no args)
/ralph stop                Stop the current loop
/ralph status              Show loop status
/ralph presets             List available presets
/plan [idea]               Start a PDD planning session
```

### Examples

```
/ralph feature Add user authentication with JWT tokens
/ralph code-assist Implement rate limiting for the API
/ralph debug Tests fail intermittently in CI
/ralph spec-driven Build a plugin system
/ralph refactor Extract auth logic into a separate module
/ralph review Review changes in src/auth/
/plan Build a real-time notification system
```

### With pi-slack-bot

If you're using [pi-slack-bot](https://github.com/samfoy/pi-slack-bot), use `!` instead of `/`:

```
!ralph feature Add user authentication
!ralph stop
!plan Build a notification system
```

The Slack bot also provides an interactive preset picker when you run `!ralph` with no arguments.

## Custom Presets

Create YAML preset files in any of these locations (later overrides earlier):

1. `~/.pi/agent/extensions/ralph/presets/` (built-in)
2. `~/.pi/agent/ralph/presets/` (user)
3. `<project>/.pi/ralph/presets/` (project-specific)

### Preset Format

```yaml
event_loop:
  starting_event: "build.start"       # Event that triggers the first hat
  completion_promise: "LOOP_COMPLETE"  # Magic string the agent outputs when done
  max_iterations: 50                   # Safety limit
  max_runtime_seconds: 14400           # Optional timeout

core:
  guardrails:                          # Optional rules injected into every hat
    - "Tests must pass before committing"
    - "Follow existing code patterns"

hats:
  planner:
    name: "📋 Planner"
    description: "Creates implementation plan"
    triggers: ["build.start"]          # Events this hat responds to
    publishes: ["tasks.ready"]         # Events this hat can emit
    default_publishes: "tasks.ready"   # Fallback if no explicit event detected
    instructions: |
      ## PLANNER MODE
      Your detailed instructions here...

  builder:
    name: "⚙️ Builder"
    description: "Implements the plan"
    triggers: ["tasks.ready"]
    publishes: ["build.done"]
    default_publishes: "build.done"
    instructions: |
      ## BUILDER MODE
      Your detailed instructions here...
```

### How It Works

1. The loop starts by finding the hat triggered by `starting_event`
2. Hat instructions are injected into the system prompt
3. The agent works under that hat's guidance
4. When done, the agent publishes an event: `>>> EVENT: event_name`
5. Ralph finds the next hat triggered by that event
6. Repeat until the agent outputs the `completion_promise` or limits are hit

## PDD (Prompt-Driven Development)

The `/plan` command starts an interactive planning session that transforms a rough idea into:

1. **Requirements** — iterative Q&A to refine scope
2. **Research** — technology investigation with documented findings
3. **Design** — detailed architecture with diagrams and acceptance criteria
4. **Implementation plan** — numbered steps ready for execution

All artifacts are saved to `specs/<task-name>/`. The session is user-driven — Ralph won't proceed to the next phase without your confirmation.

After planning, you can hand off to autonomous implementation:

```
/ralph code-assist    # Follow the plan with TDD
/ralph spec-driven    # Implement against the spec
```

## Credits

Inspired by [ralph-orchestrator](https://github.com/mikeyobrien/ralph-orchestrator) by [@mikeyobrien](https://github.com/mikeyobrien) — the original Ralph Wiggum technique for autonomous AI agent orchestration.

## License

[MIT](LICENSE)
