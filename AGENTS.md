# AGENTS.md — pi-dynamic-workflows (xdd-agent fork)

## What this extension is

`pi-dynamic-workflows` is a Pi coding-agent extension that adds multi-agent workflow orchestration: one prompt → a JavaScript orchestration script → fan-out across up to 16 concurrent / 1000 total subagents → cross-verification → one synthesized result. It is a fork of [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) (based at v3.4.1) maintained at [xdd-agent/pi-dynamic-workflows](https://github.com/xdd-agent/pi-dynamic-workflows).

**Fork differences from upstream:**

1. **`allowedExtensions`** — per-run extension allowlisting for subagents. In upstream, subagent sessions always load zero host extensions (`noExtensions: true`). This fork allows callers to opt into loading a specific subset. Threaded through the entire stack: tool schema → manager → agent → resource loader → persistence → saved workflows.
2. **Peer dependency floor** — bumped `@earendil-works/pi-coding-agent` from `>=0.80.6` to `>=0.80.8`.

## Architecture overview

The system is a TypeScript Pi extension with ~45 source files in `src/`, ~50 test files in `tests/`, 2 skills, and 5 docs files. It registers two tools (`workflow` and `workflow_control`) plus slash commands for workflow management, model-tier editing, and the 5 built-in workflow patterns.

### Layered architecture

```
┌────────────────────────────────────────────────┐
│  LLM-Facing Tools                              │
│  workflow-tool.ts    workflow-control-tool.ts   │
│  (defines the tool schemas the model calls)    │
├────────────────────────────────────────────────┤
│  Slash Commands & Editor Hooks                 │
│  builtin-commands.ts  workflow-commands.ts     │
│  saved-commands.ts    workflow-editor.ts       │
│  effort-command.ts    workflows-models.ts      │
├────────────────────────────────────────────────┤
│  Run Lifecycle Manager                         │
│  workflow-manager.ts                           │
│  (start/stop/pause/resume, persistence, leases)│
├────────────────────────────────────────────────┤
│  Core Workflow Engine                          │
│  workflow.ts                                   │
│  (parse, vm sandbox, globals, resume, fan-out) │
├────────────────────────────────────────────────┤
│  Subagent Spawning                             │
│  agent.ts (model resolution, tool assembly)    │
├────────────────────────────────────────────────┤
│  Persistence & State                           │
│  run-persistence.ts  fs-persistence.ts         │
│  workflow-saved.ts   shared-store.ts           │
│  workflow-settings.ts  logger.ts               │
├────────────────────────────────────────────────┤
│  Model Routing & Config                        │
│  model-routing.ts  model-spec.ts               │
│  model-tier-config.ts  agent-registry.ts       │
├────────────────────────────────────────────────┤
│  Built-in Pattern Generators                   │
│  deep-research.ts  adversarial-review.ts       │
│  code-review.ts  builtin-workflows.ts          │
│  web-tools.ts                                  │
├────────────────────────────────────────────────┤
│  Display & UI                                  │
│  display.ts  workflow-ui.ts  task-panel.ts     │
│  structured-output.ts  agent-history.ts        │
├────────────────────────────────────────────────┤
│  Governance & Release                          │
│  workflow-capability-contract.ts               │
│  workflow-authoring-coverage.ts                │
│  workflow-comprehension.ts                     │
│  workflow-release-gate.ts                      │
└────────────────────────────────────────────────┘
```

## Key modules

### `src/workflow.ts` — Core engine (~1616 lines)
The heart of the system. `runWorkflow(script, options)` parses a user-authored JavaScript workflow script, strips the `export const meta` header via `acorn` AST parsing, and executes the body inside a `node:vm` sandbox. The sandbox injects globals: `agent()`, `parallel()`, `pipeline()`, `phase()`, `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `gate()`, `checkpoint()`, `log()`, `args`, `cwd`, `process`, `budget`, and `console`.

Key mechanisms:
- **Deterministic journaling:** every `agent()` call is hashed (SHA-256 of prompt + model + phase + agentType + schema). On resume, unchanged calls replay from cache; the first changed call and everything after re-runs live (longest-unchanged-prefix contract).
- **Batch-scoped cancellation:** uses `AsyncLocalStorage` so a `parallel()`/`pipeline()` fan-out that breaches `maxAgents` only cancels its own queued agents, not sibling or outer fan-outs.
- **Soft token budgets:** a pre-call gate enforced per `agent()` invocation. Per-phase sub-budgets (`phase(title, { budget: N })`) carve from the run total. In-flight agents may overshoot slightly.
- **Run-fatal abort:** if an error escapes the top-level script completely uncaught, `shared.runFatalController.abort()` fires, aborting all in-flight sibling agents.
- **Un-awaited agent draining:** the top-level `finally` block awaits every `agent()` call ever spawned (even ones the script forgot to `await`) before disposing the `SharedStore`.

### `src/workflow-manager.ts` — Run lifecycle (~1431 lines)
Central hub for background execution, pause/resume, and persistence. Holds `ManagedRun` objects (each with an `AbortController` and cross-process `RunLease`). Handles:
- `startInBackground()` — acquires a lease, persists initial state, launches `executeRun()` asynchronously with event callbacks
- `pause()`/`resume()`/`stop()` — lifecycle control
- `executeRun()` — wires `runWorkflow()` with `onAgentStart`/`onAgentEnd`/`onAgentJournal`/`onLog`/`onPhase`/`onTokenUsage` callbacks
- Journal persistence (throttled to 400ms)
- Terminal run eviction (max 20 in-memory, 300 on disk)
- `recoverStaleRuns()` — cleans up runs left "running" by a dead process
- `reconfigureAfterReload()` — refreshes options across `/reload`

### `src/agent.ts` — Subagent spawning
`WorkflowAgent.run(prompt, options)` is the "leaf node" of orchestration. It:
1. Builds the tool set (applying agentType allowlist/denylist, injecting `structured_output` tool if schema provided)
2. Resolves the model spec (explicit model > agentType model > tier > phase model > implicit medium > session default)
3. Creates a Pi agent session (`createAgentSession`) and prompts it
4. Handles structured output repair (re-prompt if model doesn't call the tool, then prose JSON extraction fallback)
5. Detects provider usage limits (quota/rate-limit) buried in assistant message metadata
6. Uses a shared `DefaultResourceLoader` across all subagents of a run (memory leak mitigation, #109)

**Fork addition:** `WorkflowAgentOptions.allowedExtensions` controls which host extensions are loaded. When set, `noExtensions: false` is used and an `extensionsOverride` callback filters loaded extensions by directory basename. When undefined, `noExtensions: true` (backward compatible). The filtering logic is in `getSharedResourceLoader()`.

### `src/workflow-tool.ts` — Tool definition
Defines the `workflow` tool schema (script/name/args/background/maxAgents/concurrency/agentRetries/agentTimeoutMs/tokenBudget/resumeFromRunId/allowedExtensions). The `execute()` method resolves `name` through the same registry as slash commands (saved > built-in), normalizes the script (strips markdown fences), and either starts background execution or blocks synchronously.

### `src/workflow-capability-contract.ts` — Executable capability contract
A machine-readable declaration of every workflow capability (~25 entries: runtime globals, tool inputs, script contracts, dynamic references). Each capability has classification, support level, behavior evidence paths, and optional runtime binding. Validated at import time; used for auto-generated documentation and release validation.

### `src/shared-store.ts` — In-memory KV store
Run-scoped shared state that parallel agents can read/write via `store_put`/`store_get` tools. Implements delta journaling: each agent's writes are tracked by `deltaKey` (`${runId}:${callIndex}`), committed on success, discarded on failure. On resume, deltas are replayed additively in callSeq order.

### `src/extension-reload.ts` — `/reload` handoff
Preserves live workflow state across Pi's `/reload`. Before the old extension is torn down, `handoffWorkflowRuntime()` stages the manager to a global `Map`. The new extension generation claims it via `claimWorkflowRuntime()`. Only exact version matches are retained; version mismatches fall back to a fresh manager.

### `src/builtin-workflows.ts` — Built-in pattern registry
Single source of truth for the 5 curated built-in patterns (deep-research, adversarial-review, code-review, multi-perspective, codebase-audit). Both slash commands and the `workflow` tool's `name` input resolve through `resolveWorkflowInvocation()`, which checks saved workflows first (project > user), then falls back to built-ins.

### `src/model-spec.ts` — Model spec resolution
Parses `provider/modelId[:thinking]` strings. Handles provider-qualified specs, bare model IDs, fuzzy matching, alias vs. dated-version preference, thinking level suffixes, and provider fallback.

### `src/model-tier-config.ts` — Tier configuration
User-configurable tier mapping (small/medium/big → model spec). Stored in `~/.pi/workflows/model-tiers.json`. `rankByCapability()` sorts models by output price, then name-substring hints, then context window.

### `src/adversarial-review.ts`, `src/deep-research.ts`, `src/code-review.ts` — Pattern generators
Each generates a complete JavaScript workflow script string for its pattern. These are pure string generation functions — no runtime dependencies. They use `JSON.stringify()` for safe embedding of user-supplied strings.

### `src/workflow-ui.ts` — Interactive navigator (~1790 lines)
Full `/workflows` TUI navigator with runs → phases → agents → detail drill-down. Complex state machine with navigation stack. Two-pane layout (Phases | Agents) using box-drawing glyphs. Agent detail pager with syntax-highlighted prompts/results/history.

### Other important modules
- **`src/display.ts`** — snapshot rendering for TUI and tool output, token/cost formatting
- **`src/task-panel.ts`** — live "Workflows running" panel below editor, result delivery back to conversation
- **`src/workflow-editor.ts`** — keyword trigger detection and prompt rewriting ("workflows mode")
- **`src/effort-command.ts`** — `/effort off|high|ultra` and `/ultracode` commands
- **`src/usage-limit-scheduler.ts`** — auto-resumes runs paused on provider usage limits with exponential backoff
- **`src/worktree.ts`** — git worktree creation/teardown for isolated agent execution
- **`src/agent-registry.ts`** — loads named `agentType` definitions from `.pi/agents/*.md` files
- **`src/run-persistence.ts`** — file-system persistence with atomic writes, backup recovery, cross-process leases
- **`src/fs-persistence.ts`** — shared filesystem primitives (atomic JSON write with backup, corrupt-file recovery)
- **`src/workflow-settings.ts`** — layered settings: project override on top of `~/.pi/workflows/settings.json`
- **`src/errors.ts`** — `WorkflowError` hierarchy with recoverability flags, provider usage limit detection
- **`src/config.ts`** — all hard-coded constants (MAX_AGENTS_PER_RUN=1000, MAX_CONCURRENCY=16, etc.)

## Extension entry point

`extensions/workflow.ts` is the pi extension factory. On load it:
1. Creates `WorkflowStorage` and loads settings
2. Claims any live manager from a previous session (reload handoff) or creates a fresh one
3. Registers `workflow` and `workflow_control` tools
4. Registers all slash commands (built-in + saved)
5. Installs session hooks: `session_start` (model registry sharing, tool activation, task panel) and `session_shutdown` (reload handoff or discard)
6. Creates `UsageLimitScheduler` for auto-resume on quota refill
7. Installs result delivery for background runs

## How a workflow executes (end-to-end)

1. **Model calls the `workflow` tool** with a script (or `name` of a saved/built-in workflow) and optional args
2. **`workflow-tool.ts`** resolves the name through `resolveWorkflowInvocation()` (saved > built-in), normalizes the script, and calls `manager.startInBackground()` or `manager.runSync()`
3. **`workflow-manager.ts`** creates a `ManagedRun`, acquires a lease, persists initial state, and calls `runWorkflow()`
4. **`workflow.ts`** parses the script via `acorn`, validates `export const meta`, strips the header, creates a `SharedRuntime` (limiter, tokens, agent count, abort controller), and executes the body in a `vm` context
5. **Each `agent()` call** hashes its identity (prompt + model + phase + agentType + schema), checks the journal for a cache hit, and if live, acquires a concurrency slot, reserves an agent count, and calls `WorkflowAgent.run()`
6. **`WorkflowAgent.run()`** builds the tool set, resolves the model spec, creates a Pi agent session with the shared resource loader, prompts it, and handles the result (structured output repair if needed)
7. **On completion**, the manager persists the journal entry, updates the snapshot, emits events to the UI panel
8. **On top-level completion**, the manager marks the run terminal, releases the lease, and delivers the result

## Determinism and resume

The resume mechanism is positional, not semantic. Every `agent()` call is hashed and journaled by its call index (the order in which `agent()` calls execute). On resume:
- Calls that match their journaled hash replay from cache (no token spend)
- The first call that misses (changed prompt, different model, etc.) and everything after re-runs live
- Inserting, removing, or reordering calls shifts indices and invalidates cache from that point

The `vm` sandbox neuters `Math.random()`, `Date.now()`, and `new Date()` to prevent accidental nondeterminism. This is not a security boundary — a determined script could bypass it.

## Fork-specific: `allowedExtensions` feature

The `allowedExtensions` parameter on the `workflow` tool controls which host extensions are loaded into subagent sessions. It flows through:

1. **`workflow-tool.ts`** — added to the tool input schema (`Type.Optional(Type.Array(Type.String()))`)
2. **`workflow-manager.ts`** — stored on `ManagedRun.allowedExtensions`, threaded through `ExecOptions`, persisted in `PersistedRunState.allowedExtensions`
3. **`agent.ts`** — `WorkflowAgentOptions.allowedExtensions`; when defined, `getSharedResourceLoader()` sets `noExtensions: false` and filters via `extensionsOverride`
4. **`builtin-workflows.ts`** — `BuiltinWorkflowInvocation.allowedExtensions`, forwarded from saved workflows
5. **`workflow-saved.ts`** — `SavedWorkflow.allowedExtensions`, persisted with saved workflow definitions
6. **`run-persistence.ts`** — `PersistedRunState.allowedExtensions`, survives reload/resume

The basename extraction logic in `getSharedResourceLoader()`:
- For directory-based extensions (`.../fetch-full/index.ts`) → uses the parent directory name (`fetch-full`)
- For single-file extensions (`.../credential-guard.ts`) → uses the filename without extension (`credential-guard`)

## Development workflow

```bash
npm install
npm test              # Biome, TypeScript, unit tests, and release checks
npm run build         # tsc compile
npm run docs:check    # verify generated docs are fresh
npm run context:check # verify context measurements are fresh
npm run guidance:check # verify frozen guidance hashes match
```

### Key scripts
- `npm run release:check` — full release gate (build + docs + context + tests + release verify)
- `npm run docs:generate` — regenerate the capability index and details
- `npm run context:generate` — regenerate context surface measurements
- `npm run guidance:accept -- <path>` — accept changes to a frozen guidance file (updates its SHA-256 hash)

### Test structure
- **~50 test files** in `tests/`, using the built-in `node:test` runner
- Tests inject fake agents (`ScenarioAgentFixture`) for deterministic replay — the fake agent is NOT a substitute for end-to-end testing with a real provider
- `tests/helpers/fake-home.ts` — isolates tests from real user config by overriding `HOME`/`USERPROFILE`
- `tests/helpers/mock-pi.ts` — creates mock Pi `ExtensionAPI` objects

### Protected guidance system
Some files under `skills/workflow-authoring/` are "guidance-frozen" — their SHA-256 hashes are pinned in `src/workflow-authoring-coverage.ts`. Changing a frozen file requires:
1. Make the change
2. Run `npm run guidance:accept -- skills/workflow-authoring/path/to/file`
3. Run `npm run guidance:check` to verify
4. For semantic changes, also update relevant behavioral tests and review provider evidence

## Important invariants

1. **Never change the positional resume contract.** Journal entries are keyed by call index. Changing the order, insertion, or removal semantics breaks resume.
2. **New tool parameters must be optional with conservative defaults.** Backward compatibility is mandatory for all `workflow` tool schema changes.
3. **The capability contract is the source of truth for docs.** Three generated copies (README, `docs/workflow-authoring.md`, `skills/.../capabilities.md`) must stay in sync.
4. **Stable facts go in the contract, detailed guidance goes in the skill.** The always-on workflow prompt is ~742 bytes by design — keep it minimal.
5. **Fake-agent unit tests are necessary but not sufficient for runtime changes.** Any change to retries, timeouts, model routing, token accounting, concurrency, or resume must be verified end-to-end against a real Pi subagent session.
6. **`dist/` is NOT tracked in git.** jiti compiles TypeScript on-the-fly for git-installed extensions — pre-built output is unnecessary. Run `npm run build` only when preparing an npm publish.
7. **The shared `DefaultResourceLoader`** in `agent.ts` is the #109 memory mitigation — one loader per run, not per subagent. Do not regress this to per-agent loading.

## Key file paths

| Path | Purpose |
|---|---|
| `src/workflow.ts` | Core engine: parse, run, resume, globals |
| `src/workflow-manager.ts` | Run lifecycle: start/stop/pause/resume |
| `src/agent.ts` | Subagent spawning: model resolution, tool assembly |
| `src/workflow-tool.ts` | `workflow` tool definition + prompt guidance |
| `src/workflow-control-tool.ts` | `workflow_control` tool definition |
| `src/workflow-capability-contract.ts` | Executable capability declaration |
| `src/shared-store.ts` | In-memory KV store with delta journaling |
| `src/builtin-workflows.ts` | Built-in pattern registry |
| `src/workflow-ui.ts` | Interactive `/workflows` navigator |
| `src/task-panel.ts` | Live progress panel + result delivery |
| `src/workflow-editor.ts` | Keyword arming + prompt rewriting |
| `src/extension-reload.ts` | `/reload` runtime handoff |
| `extensions/workflow.ts` | Extension entry point |
| `skills/workflow-authoring/SKILL.md` | Authoring skill entry point |
| `skills/workflow-patterns/SKILL.md` | Built-in pattern reference |
| `docs/workflow-authoring.md` | Generated capability reference |
| `CONTRIBUTING.md` | Contributor conventions |

## When adding a feature

1. Add the parameter to `src/workflow-tool.ts` schema (optional, conservative default)
2. Thread through `src/workflow-manager.ts` (`ExecOptions`, `ManagedRun`, persist/resume)
3. If relevant to subagents, add to `src/agent.ts` (`WorkflowAgentOptions`, `AgentRunOptions`)
4. If state must survive resume, add to `src/run-persistence.ts` (`PersistedRunState`)
5. If saved workflows need it, add to `src/workflow-saved.ts` (`SavedWorkflow`)
6. If built-in workflows provide it, add to `src/builtin-workflows.ts` (`BuiltinWorkflowInvocation`)
7. Update README.md (the agent options table or the settings paragraph)
8. Optionally: add to the capability contract (`src/workflow-capability-contract.ts`) for auto-generated doc coverage
9. Add tests
