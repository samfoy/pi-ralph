# Changelog

## 1.0.0 (2026-04-19)


### Features

* add iterate preset and refactor committer hat ([9e2275d](https://github.com/samfoy/pi-ralph/commit/9e2275d152e09f3ba9044bdf48c890b604d1346c))
* add single_task isolation to prevent builder from batching all tasks ([10d320b](https://github.com/samfoy/pi-ralph/commit/10d320bbf6af88611c9836daab8fa10e6d8da9af))
* add start_ralph_loop tool and skill for LLM-initiated loops ([86d7ad9](https://github.com/samfoy/pi-ralph/commit/86d7ad974bde7e00131b6e9bd5c4471c2a19728c))
* add strict linting, extract orchestration logic, improve type safety ([b753d0b](https://github.com/samfoy/pi-ralph/commit/b753d0bf84ca21102f9e0d422421b8947b97f343))
* extract lib, add tests, fix event graphs, add user steering ([ffa15ec](https://github.com/samfoy/pi-ralph/commit/ffa15ec3f87fe6a579223b79599fc0034fc1ffa2))
* fresh sessions per hat, scratchpad, tool restrictions, XML events ([173a587](https://github.com/samfoy/pi-ralph/commit/173a587d5a265ced4b76b73232a0be63b538a576))
* **loops:** add loop history persistence and /ralph loops explorer ([b390bdd](https://github.com/samfoy/pi-ralph/commit/b390bdd7cd457a6136ee80b4350432a39e9be87a))
* Ralph orchestration extension for pi ([864bbb4](https://github.com/samfoy/pi-ralph/commit/864bbb4f73a01275107821e500a0f726fe584baa))
* **ralph:** add paused flag to loop state ([9627fc2](https://github.com/samfoy/pi-ralph/commit/9627fc200165fb36b3a6b7e9116377f83e899f56))
* rename to pi-ralph, add pi-package keyword and peer deps ([60ef141](https://github.com/samfoy/pi-ralph/commit/60ef141cfee826d97d84bc178cbb210451f3a9f4))
* **tui:** add iteration history viewer with scrollable TUI ([fc2e178](https://github.com/samfoy/pi-ralph/commit/fc2e178c65d2a2f45506579ab7349a3f0661ea87))
* **ui:** convert /ralph history to overlay popup modal ([7553064](https://github.com/samfoy/pi-ralph/commit/7553064c943778c2a490636a7c4a01807e4a6931))
* **ui:** convert history and loops commands to overlay popup modals ([fa56c2a](https://github.com/samfoy/pi-ralph/commit/fa56c2adc98ddd6817dbc632be37aa975a485d36))


### Bug Fixes

* **event-detection:** don't default to approved when reviewer emits changes_requested in earlier message ([fe4f3f3](https://github.com/samfoy/pi-ralph/commit/fe4f3f3ccf6d91910751047ffb67998f101865af))
* pendingKickoff timing, default_publishes, and tool loop setup ([9cdc601](https://github.com/samfoy/pi-ralph/commit/9cdc601724b387a11f9ef21580ff6a2df396a4c2))
* persist terminal state in stopLoop to prevent zombie loop restore ([dabba72](https://github.com/samfoy/pi-ralph/commit/dabba723a7adbca9dbbc0c682c0857d54b7b2e5d))
* **ralph:** reorder pause check to enable auto-resume on user message ([ab68e67](https://github.com/samfoy/pi-ralph/commit/ab68e67e408d9888135d4842826ab757a61dbed6))
