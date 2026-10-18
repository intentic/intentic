import { join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { declaredChecks } from "../../rules/repo-checks.js";
import { standing } from "../../rules/rules.js";
import { jsExecutionServer } from "../../execution/js-tool.js";
import { JS_SUBJECT } from "../../guard/command-guard.js";
import { sealedDoor } from "../../guard/outside-results.js";
import { GATE_SERVER, gateServer } from "./policy-gate-server.js";
import type { TurnPersona } from "../../personas/personas.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import type { TurnContext } from "../../agent/providers/adapter.js";
import { type HarnessHooksDeps, turnChecksOf } from "../../agent/run/harness/harness-hooks.js";
import {
    accountsFactoryFor,
    depsServerFor,
    diagnosticsServerFor,
    type HarnessServersDeps,
    secretsServerFor,
    subagentsServerFor,
    turnSecretAccess,
    watchServerFor,
} from "../../agent/run/harness/harness-servers.js";
import { opt } from "../../opt.js";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import { uiServer } from "../../agent/pages/ui-server.js";
import { sdkServerDoor } from "./sdk-door.js";
import type { TurnRemoteTools } from "../../agent/tools/turn-tools.js";
import type { InProcessServer } from "../../agent/tools/turn-mounts.js";
import { createTurnRelay, type TurnRelay } from "./turn-relay.js";

// The daemon's own tools for a runtime that is not the Claude Code loop: the same servers that loop mounts in-process
// (harness-servers.ts, agent.ts), built for this turn, held to the same persona decisions, and served through the MCP door
// on the turn's own lease (sdk-door.ts), so Codex, OpenCode, an ACP agent, Devin or Pi reach them as the HTTP MCP servers
// they already read. What only exists once the loop runs (its stream, its watchdog, its gate) arrives through the turn's
// relay (turn-relay.ts). DAEMON-TOOLS-WIRING.md is how a runtime takes them.

export type DaemonServersDeps = HarnessServersDeps & HarnessHooksDeps;

export interface DaemonServersTurn {
    readonly input: AgentTurn;
    readonly context: TurnContext;
    // Resolved by planTurn; the open fallback a planner already uses when absent is its own to pass.
    readonly persona: TurnPersona;
    // The persona's narrowed capability manifest, the same one turnToolsOf was given.
    readonly granted: readonly Capability[];
    // The owner's settings: `chatPages` offers the page tools, the rules give the turn's end-of-turn checks.
    readonly settings: SandboxSettings;
    // What turnToolsOf mounted: the browsers and the desktop (places the secret typist may type into) and the lease every
    // server joins.
    readonly mounted: Pick<TurnRemoteTools, "browser" | "desktop" | "lease">;
    // Mount the policy gate server (runtimes/daemon-tools/policy-gate-server.ts) for a runtime whose own hooks call it. Off by default:
    // a runtime that consults the gate in-process gains nothing from offering its model three more tools.
    readonly gate?: boolean;
}

export interface DaemonServers {
    // The mounts to add to the request's `tools.remote`, after turnToolsOf's own.
    readonly tools: readonly AgentTool[];
    // Set on the request's `hooks.relay`; the loop attaches to it when it starts.
    readonly relay: TurnRelay;
    // Whether the diagnostics server is among them, for the prompt (TurnTools.diagnostics).
    readonly diagnostics: boolean;
}

// How long a client should wait on one call, where its runtime takes a per-server timeout. A card waits on a person, a
// wait on a child up to its half hour; the rest answer in seconds and keep the runtime's own default.
const CARD_WAIT_MS = 24 * 3_600_000;
const CHILD_WAIT_MS = 35 * 60_000;
const TIMEOUTS = new Map([
    ["ui", CARD_WAIT_MS],
    ["accounts", CARD_WAIT_MS],
    ["secrets", CARD_WAIT_MS],
    ["code", CARD_WAIT_MS],
    [GATE_SERVER, CARD_WAIT_MS],
    ["subagents", CHILD_WAIT_MS],
    ["deps", CHILD_WAIT_MS],
]);

// A door call the daemon answers holds the turn's watchdog for as long as it runs: the turn is waiting on the daemon (a
// card open on a person, a child it supervises), not on its vendor, and silence then is not a hang.
const heldDoor = (server: InProcessServer, relay: TurnRelay): InProcessServer => ({
    handle: async (message, signal) => {
        if (message.method !== "tools/call") {
            return server.handle(message, signal);
        }
        const release = relay.hold();
        try {
            return await server.handle(message, signal);
        } finally {
            release();
        }
    },
    close: server.close,
});

// The `ui` server: `ask` always, the page tools where the owner leaves them on. No rebase on an answer: that is the
// harness's, for the only loop whose cards park long enough to need it (TurnContext.resync).
const doorUiServer = (turn: DaemonServersTurn, relay: TurnRelay): McpSdkServerConfigWithInstance => {
    const { spec, hooks, signal } = turn.context.base;
    return uiServer({
        pages: turn.settings.chatPages
            ? {
                  workspaceRoot: turn.context.base.tools.pages?.workspaceRoot ?? spec.cwd,
                  cwd: spec.cwd,
                  placement: spec.isolation?.plan,
                  conversationId: spec.conversationId,
                  push: relay.push,
                  cards: hooks.cards,
                  signal,
              }
            : undefined,
        ask: { cards: hooks.cards, conversationId: spec.conversationId, signal, cwd: spec.cwd, push: relay.push },
    });
};

// The JS backend, its script consulted against the loop's gate before it runs (there is no hook in front of a door
// tool to ask); its result is sealed and marked at the door like every other server's.
const codeServer = (turn: DaemonServersTurn, relay: TurnRelay, secrets: SecretAccess): McpSdkServerConfigWithInstance | undefined => {
    const { tools, spec, signal } = turn.context.base;
    return tools.jsExecution === undefined
        ? undefined
        : jsExecutionServer({
              plan: tools.jsExecution,
              placement: spec.isolation,
              signal,
              // The same secret seam the turn's typist uses, as the Claude loop's backend resolves references through.
              secrets,
              consult: (code) => relay.consult(code, JS_SUBJECT),
          });
};

/**
 * The daemon's own servers for one non-Claude turn, mounted on its lease, with the relay its loop attaches to. Every
 * name the returned servers literal holds is reserved in the contract and held to its outside-result classification by
 * outside-results.test.ts, which reads this literal as text.
 */
export const daemonServersFor = (deps: DaemonServersDeps, turn: DaemonServersTurn): DaemonServers => {
    const relay = createTurnRelay();
    const { input, context, granted } = turn;
    const signal = context.base.signal;
    const secrets = context.base.tools.secrets ?? turnSecretAccess(deps, input, signal);
    const accounts = accountsFactoryFor(deps, input, context, granted);
    const checks = turnChecksOf(deps, context, declaredChecks(standing(turn.settings.rules, "turn.ending"))).turnChecks;
    const servers = {
        ui: doorUiServer(turn, relay),
        accounts: accounts?.(relay.push, signal),
        secrets: secretsServerFor(deps, {
            browser: turn.mounted.browser,
            desktop: turn.mounted.desktop,
            granted,
            secrets,
            conversationId: input.conversationId,
            signal,
        }),
        subagents: subagentsServerFor(deps, turn),
        watch: watchServerFor(deps, turn),
        deps: depsServerFor(deps, turn),
        diagnostics: diagnosticsServerFor(deps, turn),
        code: codeServer(turn, relay, secrets),
        gate:
            turn.gate === true
                ? gateServer({
                      turn: () => {
                          const guard = relay.guard();
                          return {
                              gate: guard?.gate,
                              push: relay.push,
                              hold: relay.hold,
                              allowedTools: context.base.policy.allowedTools,
                          };
                      },
                      mark: relay.mark,
                      turnChecks: checks,
                      hooks: relay.gateHooks,
                  })
                : undefined,
    } satisfies Record<string, McpSdkServerConfigWithInstance | undefined>;
    const tools = Object.entries(servers).flatMap(([name, config]) =>
        config === undefined
            ? []
            : [
                  turn.mounted.lease.open({
                      name,
                      target: {
                          kind: "daemon",
                          server: sealedDoor(heldDoor(sdkServerDoor(config), relay), name, relay.mark, {
                              logsDir: join(deps.config.historyRoot, "logs"),
                              spec: turn.settings.outputCleaners,
                              holdout: turn.settings.outputHoldout,
                              conversationId: input.conversationId,
                          }),
                      },
                      ...opt("timeoutMs", TIMEOUTS.get(name)),
                  }),
              ],
    );
    return { tools, relay, diagnostics: servers.diagnostics !== undefined };
};
