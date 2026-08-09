import { access } from "node:fs/promises";
import { type AgentHarness, type AgentProvider, capabilitiesOf, PI_PROVIDER } from "@intentic/sandbox-contract";
import { codexReadiness } from "../codex/codex-readiness.js";
import { OPENCODE_BINARY_MISSING } from "../grok/opencode.js";
import { onPath } from "../platform/on-path.js";
import type { AdapterHealth, AgentAdapter } from "./adapter.js";
import { planAcpTurn, planCodexTurn, planGrokTurn, planHarnessTurn, planPiTurn } from "./turn-plan.js";

/* RUNTIME → ADAPTER. The whole dispatch, in one table, so adding a runtime is a row rather than a fifth arm
 * grown onto an if/else chain — and so the question "which runtimes exist" has an answer a reader can see.
 *
 * Keyed by RUNTIME rather than by provider, because that is what actually serves the turn: a `codex` provider
 * on the `claude-code` harness is served by the Claude Code loop pointed at the translator, and filing it under
 * a codex adapter would send it somewhere it never runs. `capabilitiesOf` already answers "which runtime" for
 * a (provider, harness) pair, and going through it here is what keeps the arm that serves a turn and the
 * abilities the rest of the daemon gates on reading the same row.
 *
 * The health probes below are the cheap, off-turn-path version of the question each adapter's `preflight`
 * answers expensively and at the worst moment. They deliberately do NOT resolve models or build requests: a
 * probe that did would be a turn, and the point is to answer before there is one. */

const now = (): number => Date.now();
const ready = (): AdapterHealth => ({ state: "ready", checkedAt: now() });
const unavailable = (detail: string): AdapterHealth => ({ state: "unavailable", detail, checkedAt: now() });
// A probe that could not run at all. NOT "unavailable": a network blip on an account listing must not grey out
// a provider the user can in fact use — see AdapterHealth.state.
const unknown = (): AdapterHealth => ({ state: "unknown", checkedAt: now() });

/* Run a probe's one fallible call, mapping ANY failure to undefined — which every caller below reads as
 * "unknown".
 *
 * A try/catch rather than `.catch()` on the returned promise, because the two do not catch the same things: a
 * store that throws SYNCHRONOUSLY (a bad path, a mock, a getter that blows up before it can return a promise)
 * never produces a promise for `.catch` to attach to, and the throw escapes into the caller. Here that caller
 * is a background timer, so it would surface as an unhandled rejection every five minutes rather than as the
 * "unknown" this is all built to answer with. */
const attempt = async <T>(fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
        return await fn();
    } catch {
        return undefined;
    }
};

const CLAUDE_CODE_ADAPTER: AgentAdapter<"claude-code"> = {
    runtime: "claude-code",
    preflight: (services, input, context, installed) => planHarnessTurn(services, input, context, installed),
    /* The Claude Code loop is in-process (the Agent SDK, not a CLI), so there is no binary to look for and the
     * only thing that can be missing is the credential. Which credential depends on where the turn is pointed —
     * a routed provider rides the translator, a native Claude turn its own OAuth — and resolving that needs the
     * turn. So this answers the weaker question the picker actually needs: is ANY way in configured. */
    health: async (services) => {
        if (services.config.anthropicApiKey !== "" || services.config.translator.url !== "") {
            return ready();
        }
        const accounts = await attempt(() => services.claudeStore.list());
        if (accounts === undefined) {
            return unknown();
        }
        return accounts.length > 0 ? ready() : unavailable("Connect your Claude subscription in Sandbox ▸ Agent.");
    },
    holdsSession: (services, sessionId, cwd) => services.sessions.exists(cwd, sessionId),
};

const CODEX_ADAPTER: AgentAdapter<"codex"> = {
    runtime: "codex",
    preflight: (services, input, context) => planCodexTurn(services, input, context),
    // The same question planCodexTurn refuses on, asked without building a turn — one resolver, so the tooltip
    // and the refusal can never name different reasons (codex/codex-readiness.ts).
    health: async (services) => {
        const readiness = await attempt(() => codexReadiness(services));
        if (readiness === undefined) {
            return unknown();
        }
        return readiness.ok ? ready() : unavailable(readiness.detail);
    },
    // One sandbox-wide CODEX_HOME serves every turn (see planCodexTurn), so a thread is looked up without a cwd.
    holdsSession: (services, sessionId) => services.codexThreadExists(sessionId),
};

const OPENCODE_ADAPTER: AgentAdapter<"opencode"> = {
    runtime: "opencode",
    preflight: (services, input, context) => planGrokTurn(services, input, context),
    health: async (services) => {
        const connected = await attempt(() => services.openCode.connected("xai"));
        if (connected === undefined) {
            return unknown();
        }
        if (!connected) {
            return unavailable("Sign in with your xAI (SuperGrok/X Premium) account in Setup.");
        }
        // Signed in, but OpenCode is a feature pack and this image may not carry it — a state the credential
        // cannot explain and only a rebuild fixes.
        return (await onPath("opencode")) ? ready() : unavailable(OPENCODE_BINARY_MISSING);
    },
    holdsSession: (services, sessionId, cwd) => services.openCode.sessionExists(sessionId, cwd),
};

const ACP_ADAPTER: AgentAdapter<"acp"> = {
    runtime: "acp",
    preflight: (services, input, context, installed) => planAcpTurn(services, input, context, installed, input.agent ?? "claude"),
    /* An ACP agent carries its own credentials — installed IS runnable — so the only thing that can be wrong is
     * that nothing is installed. Per-agent liveness (does its binary still spawn) is deliberately not probed
     * here: it would mean spawning every installed agent on a timer, and the pool already reports a spawn
     * failure as the turn's own coded refusal. */
    health: async (services) => {
        const installed = await attempt(() => services.capabilities.list());
        if (installed === undefined) {
            return unknown();
        }
        return installed.some((capability) => capability.kind === "agent")
            ? ready()
            : unavailable("Add an Agent capability to run an ACP agent here.");
    },
    /* An ACP session lives inside the agent's own process and there is no store to ask from out here — so this
     * answers for the only case that reaches a turn: the pool spawns the agent, and it either replays the
     * session or says it cannot (acp/acp-agent.ts asks it directly, at resume time). Answering "gone" from
     * here would retire every ACP session on a daemon that simply cannot see them. */
    holdsSession: async () => true,
};

const PI_ADAPTER: AgentAdapter<"pi"> = {
    runtime: "pi",
    preflight: (services, input, context, installed) => planPiTurn(services, input, context, installed),
    /* Two things have to hold, and each is a different fix: the reserved `pi` capability must be installed
     * (Setup ▸ Extend), and its command must resolve on PATH — Pi ships as an npm package the capability's
     * image fragment bakes in, so a card added before the rebuild is exactly the state this names. Probed on
     * the command's head, the OpenCode precedent. */
    health: async (services) => {
        const installed = await attempt(() => services.capabilities.list());
        if (installed === undefined) {
            return unknown();
        }
        const capability = installed.find((entry) => entry.kind === "agent" && entry.id === PI_PROVIDER);
        if (capability === undefined || capability.kind !== "agent") {
            return unavailable("Add the Pi Agent capability to run Pi here.");
        }
        const head = capability.config.command.trim().split(/\s+/)[0] ?? "";
        return (await onPath(head)) ? ready() : unavailable(`\`${head}\` is not on PATH — rebuild the sandbox so the Pi install lands in the image.`);
    },
    /* A Pi session is a JSONL file (the id on the wire IS its path — pi/pi-agent.ts), so whether a resume can
     * still happen is whether the file is still there. Asked of the filesystem rather than of Pi, because
     * there is no process between turns to ask. */
    holdsSession: async (_services, sessionId) => {
        try {
            await access(sessionId);
            return true;
        } catch {
            return false;
        }
    },
};

export const ADAPTERS: readonly AgentAdapter[] = [CLAUDE_CODE_ADAPTER, CODEX_ADAPTER, OPENCODE_ADAPTER, ACP_ADAPTER, PI_ADAPTER];

const BY_RUNTIME = new Map(ADAPTERS.map((adapter) => [adapter.runtime, adapter]));

/* The adapter serving a (provider, harness) pair. Total by construction: `runtime` is a closed union on the
 * contract's own record, and the table above covers it — adapter-registry.test.ts walks every pair and demands
 * one, the same guard agent-catalog.test.ts applies to the records themselves. */
export const adapterFor = (provider: AgentProvider, harness: AgentHarness): AgentAdapter =>
    BY_RUNTIME.get(capabilitiesOf(provider, harness).runtime) as AgentAdapter;
