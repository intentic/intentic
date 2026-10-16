import type { McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { type AgentTurn, profileOf } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { CredentialGateKind } from "@intentic/sandbox-contract/schemas/secrets";
import { ownWorktree, type TurnPlacement } from "../../../conversations/worktrees/isolation.js";
import { type AccountsServerFactory, accountsServer } from "../../../browser/tools/accounts-tools.js";
import { ANONYMOUS_BROWSER_SERVER, type BrowserTurnTools } from "../../../browser/tools/browser-tools.js";
import { fetchEmailCode } from "../../../browser/tools/email-codes.js";
import { secretsServer } from "../../../browser/tools/secrets-tools.js";
import { sandboxDesktopTypist } from "../../../desktop/desktop-secret-typing.js";
import type { Services } from "../../../composition.js";
import { createHashlineServer } from "../../../hashline/hashline-tools.js";
import { createDiagnosticsServer } from "../../../logs/diagnostics-tools.js";
import { mayDelegate, type TurnPersona } from "../../../personas/personas.js";
import { gateTargetOf } from "../../../secrets/credential-gates.js";
import { createDepsServer } from "../../../workspace/deps/deps-tools.js";
import type { TurnContext } from "../../providers/adapter.js";
import type { TurnTools } from "../../providers/agent-request.js";
import { subagentWaitServer } from "../../subagents/subagent-wait.js";
import type { SecretAccess, SecretLane } from "../../../secrets/secret-access.js";
import { watchServer } from "../../verification/watch-server.js";
import type { WatchPlacement } from "../../verification/watchers.js";
import { opt } from "../../../opt.js";

// The daemon's own servers a harness turn mounts in-process, the secret seam behind them, and the accounts tools. Each is
// withheld where the persona's powers or the turn's own facts say it would reach past them.

// What the servers and the secret seam read of the daemon.
export type HarnessServersDeps = Pick<
    Services,
    | "accountSignInUrls"
    | "agents"
    | "capabilities"
    | "cards"
    | "config"
    | "conversations"
    | "credentialGate"
    | "deviceSecrets"
    | "gatewayHeld"
    | "hostGuardGate"
    | "keyringLink"
    | "programGuardFor"
    | "secretTickets"
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

// Where a lane puts a value, in the words a refusal uses.
const LANE_PLACE = { shell: "command", code: "script", browser: "page", device: "window", desktop: "window" } as const satisfies Readonly<Record<SecretLane, string>>;

// The one object behind every secret seam this turn gets: the named registry, the use ledger its exits feed (a write
// that must never fail or slow the tool call that spent the secret), and the two gates bound to this turn: where the
// values may go, asked first since a use sent nowhere needs nobody's release, then who must release them. A name only a
// keyring on the owner's computers holds is fetched from there, for this turn's conversation, once both gates said yes.
export const turnSecretAccess = (deps: HarnessServersDeps, input: AgentTurn, signal: AbortSignal): SecretAccess => ({
    list: deps.secretRegistry,
    device: {
        held: async () => (await deps.deviceSecrets.held()).map(({ machine, pointer }) => ({ name: pointer.name, machine })),
        fetch: (name, lane, detail) => deps.deviceSecrets.fetch({ name, lane, detail, conversationId: input.conversationId, signal }),
    },
    used: (use) => {
        void deps.secretUses
            .record({ ...use, at: Date.now() })
            .catch((error: unknown) => deps.logger.warn({ err: error, secret: use.name }, "secret use record failed"));
    },
    release: async (names, lane, detail, target) => {
        if (names.length === 0) {
            return { ok: true };
        }
        // A credential the gateway holds is never resolved into a value at any exit: the request goes to the gateway.
        for (const name of names) {
            const held = await deps.gatewayHeld(name);
            if (held !== undefined) {
                const vars = held.vars.map((variable) => `\`$${variable}\``).join(", ");
                return {
                    refusal:
                        `"${name}" is held by the sandbox's credential gateway, so it is never put into a ${LANE_PLACE[lane]}. ` +
                        `Send the request to ${vars.length > 0 ? vars : `the variables its skill names`} instead, with its token variable as it is: the gateway attaches the credential.`,
                };
            }
        }
        const sent = await deps.hostGuardGate.check({
            names,
            target,
            conversationId: input.conversationId,
            signal,
        });
        if (!sent.allow) {
            return { refusal: sent.reason };
        }
        const approvedBy: Record<string, string> = {};
        // Whoever let it go off its list answers for the use, unless a named approver releases it below.
        if (sent.approvedBy !== undefined) {
            for (const name of names) {
                approvedBy[name] = sent.approvedBy;
            }
        }
        for (const [subject, { kind, names: covered }] of subjectsOf(names)) {
            const verdict = await deps.credentialGate.check({
                subject,
                kind,
                lane,
                detail,
                conversationId: input.conversationId,
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

// What the secret typist reads of the turn: the places it may type into are exactly the ones the turn mounted.
export interface TypistTurn {
    readonly browser: BrowserTurnTools;
    // Whether the sandbox's own desktop is mounted (TurnRemoteTools.desktop).
    readonly desktop: boolean;
    // The persona's narrowed capability manifest: its device and webext cards are the computers and owner's browsers
    // the turn mounted (peerToolsOf), so the typist reaches no other.
    readonly granted: readonly Capability[];
    readonly secrets: SecretAccess;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

const cardsOf = (granted: readonly Capability[], kind: "device" | "webext"): readonly string[] =>
    granted.filter((capability) => capability.kind === kind).map((capability) => capability.id);

// The exit for stored secrets into a focused field or window: a sandbox browser's page (scoped to exactly the turn's
// own browser list), the sandbox's desktop, the owner's computers and their own browsers, each only where mounted.
const typistServer = (deps: HarnessServersDeps, turn: TypistTurn): McpSdkServerConfigWithInstance => {
    const { browser } = turn;
    const anonymous = browser.servers.some((server) => server.name === ANONYMOUS_BROWSER_SERVER);
    const accounts = anonymous ? { ...browser.accounts, web: "web" } : browser.accounts;
    return secretsServer({
        secrets: turn.secrets,
        accounts,
        devices: cardsOf(turn.granted, "device"),
        keyrings: { link: deps.keyringLink, listed: () => deps.deviceSecrets.listed(), programGuardFor: deps.programGuardFor },
        ...opt("desktop", turn.desktop ? sandboxDesktopTypist() : undefined),
        ownBrowsers: cardsOf(turn.granted, "webext"),
        tickets: deps.secretTickets,
        ...opt("conversationId", turn.conversationId),
        signal: turn.signal,
    });
};

const watchPlacementOf = (isolation: TurnPlacement | undefined): { readonly placement?: WatchPlacement } =>
    !ownWorktree(isolation)
        ? {}
        : {
              placement: {
                  worktree: isolation.plan.worktree,
                  fenced: isolation.plan.fence !== undefined,
                  ...(isolation.plan.fence === undefined ? {} : { fence: isolation.plan.fence.folders }),
              },
          };

// The condition watch: the agent names an outside check command the daemon polls, waking the conversation when it exits
// 0; a replacement for hand-rolled sleep loops, which can't fire once the turn's process is gone.
const conditionWatchServer = (deps: HarnessServersDeps, conversationId: string, input: AgentTurn, context: TurnContext): McpSdkServerConfigWithInstance =>
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

// Dependency readiness asked of the main checkout: an isolated turn reads the main tree's dependencies through its own
// layer, so /work's answer is the turn's answer until the turn installs something itself. The worktree is named for
// what only it holds: a project the conversation's branch created, and where an install of its own would write.
const dependencyServer = (deps: HarnessServersDeps, input: AgentTurn, context: TurnContext, persona: TurnPersona): McpSdkServerConfigWithInstance => {
    const title = input.conversationId === undefined ? input.title : deps.agents.entry(input.conversationId)?.social.title?.text;
    return createDepsServer({
        dependencies: deps.dependencies,
        canInstall: persona.powers.files === "write" && persona.powers.shell,
        origin: { kind: "request", ...opt("conversationId", input.conversationId), ...opt("title", title) },
        worktree: ownWorktree(context.base.spec.isolation) ? context.base.spec.isolation.plan.worktree : undefined,
        signal: context.base.signal,
    });
};

// Each daemon server a turn may get, with the decision whether it gets it: one place for every loop that mounts them, the
// Claude Code loop in-process (harnessServers below) and every other runtime through the MCP door (daemon-servers.ts),
// so a persona's powers withhold the same server whichever runtime serves the turn. Undefined is withheld.
export interface DaemonServerTurn {
    readonly input: AgentTurn;
    readonly context: TurnContext;
    readonly persona: TurnPersona;
}

// The secret typist: only when this turn has somewhere to type (a browser, the desktop, a computer or the owner's own
// browser); those places themselves ride the turn's remote mounts.
export const secretsServerFor = (deps: HarnessServersDeps, turn: TypistTurn): McpSdkServerConfigWithInstance | undefined =>
    turn.browser.servers.length > 0 || turn.desktop || turn.granted.some((capability) => capability.kind === "device" || capability.kind === "webext")
        ? typistServer(deps, turn)
        : undefined;

// `wait` parks until a child of this turn settles, `keep` leaves a background command running for the person, and
// `spawn` (same server) starts a full agent on any connected provider; `wait` and `keep` are always offered, the rest
// withheld without the delegate shelf and full agency.
export const subagentsServerFor = (deps: HarnessServersDeps, { context, persona }: DaemonServerTurn): McpSdkServerConfigWithInstance =>
    subagentWaitServer({
        conversationId: context.base.spec.conversationId,
        conversations: deps.conversations,
        signal: context.base.signal,
        ...opt("children", context.children !== undefined && mayDelegate(persona) ? context.children : undefined),
    });

// Withheld without shell power or a conversation to wake.
export const watchServerFor = (deps: HarnessServersDeps, { input, context, persona }: DaemonServerTurn): McpSdkServerConfigWithInstance | undefined =>
    persona.powers.shell && input.conversationId !== undefined ? conditionWatchServer(deps, input.conversationId, input, context) : undefined;

export const depsServerFor = (deps: HarnessServersDeps, { input, context, persona }: DaemonServerTurn): McpSdkServerConfigWithInstance =>
    dependencyServer(deps, input, context, persona);

// The daemon's own records, read-only; gated on `files` rather than its own power, and withheld from a `none` card.
export const diagnosticsServerFor = (deps: HarnessServersDeps, { persona }: DaemonServerTurn): McpSdkServerConfigWithInstance | undefined =>
    persona.powers.files === "none" ? undefined : createDiagnosticsServer({ historyRoot: deps.config.historyRoot, usage: deps.usage });

// The in-process servers of a harness turn, every one named in this one literal: outside-results.test.ts reads it to
// hold each to its classification, so a server mounted anywhere else would ship unchecked.
export const harnessServers = (
    deps: HarnessServersDeps,
    turn: {
        readonly input: AgentTurn;
        readonly context: TurnContext;
        readonly persona: TurnPersona;
        readonly browser: BrowserTurnTools;
        readonly desktop: boolean;
        readonly granted: readonly Capability[];
        readonly secrets: SecretAccess;
        readonly hashlineEdits: boolean;
    },
): Record<string, McpServerConfig> => {
    const typist = secretsServerFor(deps, { ...turn, conversationId: turn.input.conversationId, signal: turn.context.base.signal });
    const watcher = watchServerFor(deps, turn);
    const records = diagnosticsServerFor(deps, turn);
    return {
        ...(typist === undefined ? {} : { secrets: typist }),
        // hashlineEdits swaps the native Edit/Write (disabled in the policy) for hash-anchored file tools.
        ...(turn.hashlineEdits ? { hashline: createHashlineServer(turn.context.localCwd) } : {}),
        subagents: subagentsServerFor(deps, turn),
        ...(watcher === undefined ? {} : { watch: watcher }),
        deps: depsServerFor(deps, turn),
        ...(records === undefined ? {} : { diagnostics: records }),
    };
};

// The accounts tools ride whenever this turn has browser accounts: the very set whose servers were just mounted is the
// scope those tools enforce, so a tool can never reach an account the browser was refused.
export const accountsFactoryFor = (
    deps: HarnessServersDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): AccountsServerFactory | undefined => {
    const accounts = granted
        .filter((capability) => capability.kind === "browser" || capability.kind === "identity")
        .map((capability) => capability.id);
    if (accounts.length === 0) {
        return undefined;
    }
    return accountsServer({
        capabilities: deps.capabilities,
        root: deps.workspace.root,
        accounts,
        ...opt("conversationId", input.conversationId),
        cards: deps.cards,
        attended: input.unattended !== true,
        // The two verbs past the narrow deps (filing a new account, reading a mailbox code), injected as closures so
        // the tools stay testable without Services or a network.
        openAccount: (request) => deps.openBrowserAccount(request),
        signInUrls: (capability) => deps.accountSignInUrls(capability),
        fetchCode: fetchEmailCode,
        release: async (account, lane, detail) => {
            const verdict = await deps.credentialGate.check({
                subject: account,
                kind: "capability",
                lane,
                detail,
                conversationId: input.conversationId,
                signal: context.base.signal,
            });
            return verdict.allow ? { ok: true } : { refusal: verdict.reason };
        },
    });
};

export const harnessAccounts = (
    deps: HarnessServersDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Pick<TurnTools, "accountsServer"> => {
    const factory = accountsFactoryFor(deps, input, context, granted);
    return factory === undefined ? {} : { accountsServer: factory };
};
