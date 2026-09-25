import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { type AgentTurn, type Capability, type CredentialGateKind, profileOf } from "@intentic/sandbox-contract";
import type { TurnPlacement } from "../../../conversations/worktrees/isolation.js";
import { accountsServer } from "../../../browser/tools/accounts-tools.js";
import { ANONYMOUS_BROWSER_SERVER, type BrowserTurnTools } from "../../../browser/tools/browser-tools.js";
import { fetchEmailCode } from "../../../browser/tools/email-codes.js";
import { secretsServer } from "../../../browser/tools/secrets-tools.js";
import type { Services } from "../../../composition.js";
import { createHashlineServer } from "../../../hashline/hashline-tools.js";
import { createDiagnosticsServer } from "../../../logs/diagnostics-tools.js";
import { mayDelegate, type TurnPersona } from "../../../personas/personas.js";
import { gateTargetOf } from "../../../secrets/credential-gates.js";
import { createDepsServer } from "../../../workspace/deps/deps-tools.js";
import type { TurnContext } from "../../providers/adapter.js";
import type { TurnTools } from "../../providers/agent-request.js";
import { subagentWaitServer } from "../../subagents/subagent-wait.js";
import type { SecretAccess } from "../../../secrets/secret-access.js";
import { watchServer } from "../../verification/watch-server.js";
import type { WatchPlacement } from "../../verification/watchers.js";
import { opt } from "../../../opt.js";

// The daemon's own servers a harness turn mounts in-process, the secret seam behind them, and the accounts tools. Each is
// withheld where the persona's powers or the turn's own facts say it would reach past them.

// What the servers and the secret seam read of the daemon.
export type HarnessServersDeps = Pick<
    Services,
    | "agents"
    | "capabilities"
    | "cards"
    | "config"
    | "conversations"
    | "credentialGate"
    | "dependencies"
    | "logger"
    | "openBrowserAccount"
    | "secretRegistry"
    | "secretUses"
    | "usage"
    | "workspace"
>;

// Secret names grouped by the credential they belong to, so a command naming two secrets of one credential is one
// decision, and different subjects are asked one after another rather than batched onto one card.
const subjectsOf = (names: readonly string[]): Map<string, { readonly kind: CredentialGateKind; readonly names: string[] }> => {
    const bySubject = new Map<string, { readonly kind: CredentialGateKind; readonly names: string[] }>();
    for (const name of names) {
        const { subject, kind } = gateTargetOf(name);
        const entry = bySubject.get(subject);
        if (entry === undefined) {
            bySubject.set(subject, { kind, names: [name] });
            continue;
        }
        entry.names.push(name);
    }
    return bySubject;
};

// The one object behind every secret seam this turn gets: the named registry, the use ledger its exits feed (a write
// that must never fail or slow the tool call that spent the secret), and the approval gate bound to this turn.
export const turnSecretAccess = (deps: HarnessServersDeps, input: AgentTurn, signal: AbortSignal): SecretAccess => ({
    list: deps.secretRegistry,
    used: (use) => {
        void deps.secretUses
            .record({ ...use, at: Date.now() })
            .catch((error: unknown) => deps.logger.warn({ err: error, secret: use.name }, "secret use record failed"));
    },
    release: async (names, lane, detail) => {
        if (names.length === 0) {
            return { ok: true };
        }
        const approvedBy: Record<string, string> = {};
        for (const [subject, { kind, names: covered }] of subjectsOf(names)) {
            const verdict = await deps.credentialGate.check({
                subject,
                kind,
                lane,
                detail,
                conversationId: input.conversationId,
                unattended: input.unattended === true,
                signal,
            });
            if (!verdict.allow) {
                return { refusal: verdict.reason };
            }
            if (verdict.approvedBy !== undefined) {
                for (const name of covered) {
                    approvedBy[name] = verdict.approvedBy;
                }
            }
        }
        return Object.keys(approvedBy).length > 0 ? { ok: true, approvedBy } : { ok: true };
    },
});

// The browser exit for stored secrets: types a named value into a live page's focused field, scoped to exactly the
// turn's own browser list.
const browserSecretsServer = (browser: BrowserTurnTools, secrets: SecretAccess): McpServerConfig =>
    secretsServer({
        secrets,
        accounts: { ...browser.accounts, ...(browser.servers.some((server) => server.name === ANONYMOUS_BROWSER_SERVER) ? { web: "web" } : {}) },
    });

const watchPlacementOf = (isolation: TurnPlacement | undefined): { readonly placement?: WatchPlacement } =>
    isolation === undefined ? {} : { placement: { worktree: isolation.plan.worktree, fenced: isolation.plan.fence !== undefined } };

// The condition watch: the agent names an outside check command the daemon polls, waking the conversation when it exits
// 0; a replacement for hand-rolled sleep loops, which can't fire once the turn's process is gone.
const conditionWatchServer = (deps: HarnessServersDeps, conversationId: string, input: AgentTurn, context: TurnContext): McpServerConfig =>
    watchServer({
        conversations: deps.conversations,
        conversationId,
        cwd: context.localCwd,
        // The base's persona-filtered env: a check must not run with a credential the card withheld.
        env: context.base.tools.cliEnv ?? {},
        // A check's /work must be this conversation's tree, fence and all.
        ...watchPlacementOf(context.base.spec.isolation),
        profile: profileOf(input),
    });

// Dependency readiness asked of the main checkout: an isolated turn's dependencies live in /work and are only mounted
// into its namespace, so /work's answer is the turn's answer.
const dependencyServer = (deps: HarnessServersDeps, input: AgentTurn, persona: TurnPersona): McpServerConfig => {
    const title = input.conversationId === undefined ? input.title : deps.agents.entry(input.conversationId)?.social.title?.text;
    return createDepsServer({
        dependencies: deps.dependencies,
        canInstall: persona.powers.files === "write" && persona.powers.shell,
        origin: { kind: "request", ...opt("conversationId", input.conversationId), ...opt("title", title) },
    });
};

// The in-process servers of a harness turn, every one named in this one literal: outside-results.test.ts reads it to
// hold each to its classification, so a server mounted anywhere else would ship unchecked.
export const harnessServers = (
    deps: HarnessServersDeps,
    turn: {
        readonly input: AgentTurn;
        readonly context: TurnContext;
        readonly persona: TurnPersona;
        readonly browser: BrowserTurnTools;
        readonly secrets: SecretAccess;
        readonly hashlineEdits: boolean;
    },
): Record<string, McpServerConfig> => {
    const { input, context, persona } = turn;
    return {
        // Mounted only when this turn drives a browser at all; the browsers themselves ride the turn's remote mounts.
        ...(turn.browser.servers.length > 0 ? { secrets: browserSecretsServer(turn.browser, turn.secrets) } : {}),
        // hashlineEdits swaps the native Edit/Write (disabled in the policy) for hash-anchored file tools.
        ...(turn.hashlineEdits ? { hashline: createHashlineServer(context.localCwd) } : {}),
        // `wait` parks until a child of this turn settles, and `spawn` (same server) starts a full agent on any connected
        // provider; always offered, and withheld only without the delegate shelf and full agency.
        subagents: subagentWaitServer({
            conversationId: context.base.spec.conversationId,
            conversations: deps.conversations,
            signal: context.base.signal,
            ...(context.children !== undefined && mayDelegate(persona) ? { children: context.children } : {}),
        }),
        // Withheld without shell power or a conversation to wake.
        ...(persona.powers.shell && input.conversationId !== undefined
            ? { watch: conditionWatchServer(deps, input.conversationId, input, context) }
            : {}),
        deps: dependencyServer(deps, input, persona),
        // The daemon's own records, read-only; gated on `files` rather than its own power, and withheld from a `none` card.
        ...(persona.powers.files === "none"
            ? {}
            : { diagnostics: createDiagnosticsServer({ historyRoot: deps.config.historyRoot, usage: deps.usage }) }),
    };
};

// The accounts tools ride whenever this turn has browser accounts: the very set whose servers were just mounted is the
// scope those tools enforce, so a tool can never reach an account the browser was refused.
export const harnessAccounts = (
    deps: HarnessServersDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Pick<TurnTools, "accountsServer"> => {
    const accounts = granted
        .filter((capability) => capability.kind === "browser" || capability.kind === "identity")
        .map((capability) => capability.id);
    if (accounts.length === 0) {
        return {};
    }
    return {
        accountsServer: accountsServer({
            capabilities: deps.capabilities,
            root: deps.workspace.root,
            accounts,
            ...opt("conversationId", input.conversationId),
            cards: deps.cards,
            attended: input.unattended !== true,
            // The two verbs past the narrow deps (filing a new account, reading a mailbox code), injected as closures so
            // the tools stay testable without Services or a network.
            openAccount: (request) => deps.openBrowserAccount(request),
            fetchCode: fetchEmailCode,
            release: async (account, lane, detail) => {
                const verdict = await deps.credentialGate.check({
                    subject: account,
                    kind: "capability",
                    lane,
                    detail,
                    conversationId: input.conversationId,
                    unattended: input.unattended === true,
                    signal: context.base.signal,
                });
                return verdict.allow ? { ok: true } : { refusal: verdict.reason };
            },
        }),
    };
};
