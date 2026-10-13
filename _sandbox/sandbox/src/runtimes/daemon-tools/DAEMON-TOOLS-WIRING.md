# Wiring the daemon's own tools into a non-Claude runtime

The Claude Code loop mounts the daemon's own servers in-process (`harness-servers.ts`, `agent.ts`). Every other loop
reaches them as HTTP MCP servers through the daemon's MCP door, on the turn's own lease. The pieces are already built.
What follows is the change each runtime still has to make.

| Piece | Module | What it does |
| --- | --- | --- |
| Adapter | `sdk-door.ts` | Serves an SDK in-process server (`createSdkMcpServer`) as the door's `InProcessServer`, mount kind `daemon`. |
| Builder | `daemon-servers.ts` `daemonServersFor` | Builds `ui`, `accounts`, `secrets`, `subagents`, `watch`, `deps`, `diagnostics`, `code` and optionally `gate` with the same persona decisions `harnessServers` makes. Mounts them on the lease, sealed by `sealedDoor` and holding the watchdog while a call runs. |
| Planner helper | `door-tools.ts` `doorToolsOf` | Step 1 below in one call: `turnToolsOf`, then `daemonServersFor` on the same lease, the turn's secret seam set on the request. Used by the OpenCode planners. |
| Relay | `turn-relay.ts` | The late half. The loop attaches its event push, watchdog hold and gate. Anything a tool did before that waits in the relay. |
| Policy | `runtimes/daemon-tools/policy-gate.ts` | `consultPolicy(turn, {tool, input})` and `createPolicyGate()` (key → turn). Fails closed. |
| Gate server | `runtimes/daemon-tools/policy-gate-server.ts` | `pre_tool_use`, `post_tool_use` and `stop` on the door, answering Claude-shaped hook-decision JSON. |
| Hook socket | `runtimes/daemon-tools/hook-socket.ts` | The 0600 Unix socket a runtime's hook script posts to (Cursor's uses it). |

## 1. Planner (every runtime with an MCP client)

Call `doorToolsOf(services, input, context, granted, gate)` in place of `turnToolsOf` (the OpenCode planners do), or add
these lines right after `turnToolsOf(...)`. The planner's deps type gains `DaemonServersDeps`, and `settings` is
`context.settings ?? await services.sandboxSettings.get()`.

```ts
const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
const daemon = daemonServersFor(services, { input, context, persona, granted, settings, mounted, gate: /* see table */ false });
const remote = [...mounted.tools, ...daemon.tools];
// in the request:
tools: { ...context.base.tools, ...(remote.length > 0 ? { remote } : {}), diagnostics: daemon.diagnostics },
hooks: { ...context.base.hooks, relay: daemon.relay },
```

`releasingMounts(loop, mounted)` stays as it is. The daemon servers ride the same lease and close with it.

| Runtime | Planner | `gate` |
| --- | --- | --- |
| Codex | `runtimes/codex/codex-provider.ts` `planCodexTurn`, after the `Promise.all` | `true`: its per-thread `hooks` call it |
| OpenCode | `planGrokTurn`, `planGeminiTurn` and `planOpenCodeRouteTurn`, through `doorToolsOf` (wired) | `false`: it asks over its permission channel |
| ACP | `runtimes/acp/acp-adapter.ts`, after `turnToolsOf` (`warmSession: true`) | `false` |
| Devin | `runtimes/devin/devin-provider.ts`, after `turnToolsOf` (`warmSession: true`) | `false` |
| Kimi CLI, Grok Build | `runtimes/vendor-cli/vendor-cli-turn.ts` `planCliTurn`, after `turnToolsOf` (`warmSession: true`) | `false` |
| Pi | `runtimes/pi/pi-adapter.ts` `planPiTurn`, after `turnToolsOf` (Pi's built-in MCP, through the daemon's extension) | `false`: its extension asks over the turn's hook socket |

The `code` server mounts only where `context.base.tools.jsExecution` is set. That requires `execution: ["js"]` in the
runtime's `AgentCapabilities` row (`agent-runtimes.ts`, read by `honoured.ts`). For ACP, Devin and the vendor CLIs, the warm session keeps
the MCP config it opened with. A server name a later turn adds (a persona change) is not seen until a new session opens.
An ACP agent that does not advertise http MCP is handed the same mounts as stdio servers through the daemon's proxy
(`runtimes/acp/acp-mcp-proxy.ts`), the bearer in each server's environment.

## 2. Loop: attach the relay

Attach once the loop has its gate and its watchdog, and detach in the same `finally` that releases the gate:

```ts
const { gate, taint, release } = vendorTurnGate(request);
const clock = turnWatchdog(timeouts);
const detach = request.hooks.relay?.attach({ push: (frame) => /* the loop's own queue */, hold: clock.hold, guard: { gate, taint } });
try { ... } finally { detach?.(); release(); }
```

| Runtime | Where | `push` |
| --- | --- | --- |
| Codex | Wired: `codex-agent.ts` `codexRunGate`, beside `vendorTurnGate(request)`. No `hold`: a Codex turn has no watchdog, so a card is bounded by each mount's `tool_timeout_sec` and the hook timeout | The run's frame inbox, read by the running phase's app-server loop (`CodexTurn.frames`) |
| OpenCode | `opencode-agent.ts` `attachRelay`, per message, once its `queue` and `clock` exist (wired) | `(frame) => queue.push({ type: "intentic.frame", frame })`, the `RaisedFrame` it already yields |
| ACP / Devin / Kimi CLI / Grok Build | `acp-agent.ts`, after `turnWatchdog(turn.timeouts)` (~264), per phase | `queue.push` (as at ~162) |
| Pi | `pi-agent.ts`, once per turn in `serve`; `hold` forwards to the running prompt's watchdog | `Relayed` frames on the turn's queue, beside Pi's events |

The relay holds the watchdog for the whole of every door call (`heldDoor`). A question card, a page, an accounts card or
a 30-minute `subagents.wait` is not read as a silent turn. Each mount's `timeoutMs` (24 h for card servers, 35 min for
`subagents`/`deps`) is what the runtime's MCP client should wait per call: Codex `tool_timeout_sec`, ACP per-server
timeouts.

## 3. Gate call site

| Runtime | How the policy is asked |
| --- | --- |
| Codex | Wired (`runtimes/codex/codex-hooks.ts`). Per-thread `hooks` with `mcp_tool` handlers on server `gate`: `PreToolUse` → `pre_tool_use {tool_name, tool_input, cwd, tool_use_id, session_id, key}`, `PostToolUse` → `post_tool_use {tool_name, tool_input, tool_response, tool_use_id, key}`, `Stop` → `stop {stop_hook_active, key}`. Answers are the subset Codex's parser takes: no `permissionDecision: "allow"` without `updatedInput`, no rewritten tool output, no `hookSpecificOutput` on Stop (Codex fails such a hook, and a failed hook lets its call through). Its approval channel still answers, from what the hook recorded per call id. |
| OpenCode, ACP, Devin, Kimi CLI, Grok Build | In-process: their permission asks already go through `answerVendorAsk`. Where a call needs the tool list or a rewrite as well, call `consultPolicy({ gate, push, hold: clock.hold, allowedTools: request.policy.allowedTools }, { tool, input })`. |
| A hook-script runtime | `createHookSocket(path, { "/gate": … })` with `createPolicyGate()`: `register(key, turn)` per turn and `consult(key, call)` per payload. Cursor (`cursor-hooks.ts`) is the worked example. |

The gate refuses whenever it cannot place a call. That covers no live turn on a turn-only seam, several turns with none
named, a turn whose loop has not attached its gate, and a consult that threw. Cursor's machine-wide hooks file is the one
exception: with no turn live at all, it allows (`noLiveTurn: "allow"`), because the caller is the owner's own Cursor.

Pi has no approval channel; the daemon's own Pi extension (`runtimes/pi/pi-extension.ts`) asks before every tool runs and
after every result, over a per-turn hook socket (`runtimes/pi/pi-hooks.ts`, `createHookSocket` with a one-turn
`createPolicyGate`).
