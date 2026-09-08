import { join } from "node:path";
import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { browserOutputDir } from "../../browser/cast/browser-artifacts.js";
import { browserServersOf } from "../../browser/tools/browser-tools.js";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import type { TurnContext, TurnPlan } from "../../agent/run/turn/turn-plan.js";
import type { Services } from "../../composition.js";
import { turnPersona } from "../../personas/personas.js";
import { createCursorAgent } from "./cursor-agent.js";
import { type CursorCatalog, createCursorCatalog } from "./cursor-catalog.js";
import { type CursorStore, fileCursorStore, readCursorCredentials, usableCursorAccount } from "./cursor-credentials.js";
import { createCursorHookService, type CursorHookService } from "./cursor-hooks.js";
import { cursorReadiness } from "./cursor-readiness.js";
import { cursorSdk } from "./cursor-sdk.js";
import { cursorAccountDoor } from "./cursor-accounts.js";
import { cursorOneShot } from "./cursor-one-shot.js";

// Everything Cursor contributes to the daemon, aggregated by the provider registry (agent/provider-module.ts); the
// directory's other files keep their own jobs. Holds only what the shared tables used to hold: the turn arm, the
// adapter row, the service slice, and the registry's answers.

// The Services members Cursor contributes; declared here so composition just spreads them and their docs live with the
// owning provider.
export interface CursorSlice {
    // Cursor subscription accounts, several per sandbox; the sandbox owns the credential, no vendor-side auth file.
    readonly cursorStore: CursorStore;
    // Live model catalog, held directly since a Cursor turn must resolve a concrete model and its parameter record.
    readonly cursorModels: CursorCatalog;
    // Socket-backed command gate, live-turn registry (cursor-hooks.ts); one per daemon, hooks file is global.
    readonly cursorHooks: CursorHookService;
    // Cursor's runtime, run in this process via @cursor/sdk, not a child; hence no spawner and cwd-based isolation.
    readonly cursorAgent: Services["agent"];
}

export const createCursorSlice = (input: { readonly authRoot: string; readonly logger: Logger }): CursorSlice => {
    const cursorStore = fileCursorStore(join(input.authRoot, "cursor"), input.logger);
    const cursorModels = createCursorCatalog(cursorStore, join(input.authRoot, "cursor", "models.json"));
    // Sited beside the credentials, not a temp dir: the socket is the authority to answer a permission card.
    const cursorHooks = createCursorHookService(join(input.authRoot, "cursor"), input.logger);
    return {
        cursorStore,
        cursorModels,
        cursorHooks,
        cursorAgent: createCursorAgent({ catalog: cursorModels, hooks: cursorHooks, logger: input.logger }),
    };
};

// Credential rides the request as a key, not an env var: Cursor runs inside this daemon, where an env var is
// daemon-wide, unlike Codex's or OpenCode's processes. Browser MCP servers come along too, the one foreign runtime that
// manages them.
export const planCursorTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
    // One resolver, shared with the health probe: the tooltip and the refusal can't disagree (cursor-readiness.ts).
    const readiness = await cursorReadiness(services.cursorStore);
    if (!readiness.ok) {
        return { ok: false, ...(readiness.code !== undefined ? { code: readiness.code } : {}), message: readiness.detail };
    }
    const account = await usableCursorAccount(services.cursorStore, input.account);
    if (account === undefined) {
        // Reachable only if disconnected after the readiness check, or a pinned id never existed; both mean pick one.
        return { ok: false, message: "That Cursor account is no longer connected. Pick another one, or connect it again in Sandbox ▸ Agent." };
    }
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // Never empty, so this always resolves: keeps the pinned model while offered, else the catalog default.
    const [catalog, browser] = await Promise.all([
        services.cursorModels.models(),
        browserServersOf(granted, services.workspace.root, persona.powers.browser, input.conversationId),
    ]);
    const model = input.model !== undefined && catalog.models.some((entry) => entry.id === input.model) ? input.model : catalog.default;
    const withAuth = {
        ...context.base,
        model,
        cursorApiKey: account.apiKey,
        ...(context.steering !== undefined ? { steering: context.steering } : {}),
        // Same predicate the harness arm applies: a child has shell and write; a narrowed turn can't proxy them back.
        ...(context.children !== undefined && persona.powers.delegate && persona.powers.shell && persona.powers.files === "write"
            ? { children: context.children }
            : {}),
    };
    const withBrowser =
        Object.keys(browser.servers).length === 0
            ? withAuth
            : {
                  ...withAuth,
                  sdkServers: browser.servers,
                  browserOutputDir: browserOutputDir(services.workspace.root),
                  browserPorts: browser.ports,
                  browserPasskeys: browser.passkeys,
                  browserAccounts: browser.accounts,
              };
    return {
        ok: true,
        run: services.cursorAgent,
        // Real account id, not a shared marker: usage and rate-limit frames can name which connection paid.
        account: account.id,
        // Attachments fold into the prompt as a file list; Cursor's read tool takes them off disk, like OpenCode/Pi.
        request: withAttachments(withBrowser, context.attachmentPaths),
    };
};

// Nothing to probe on PATH, no server to reach: what can be missing is the SDK module (a pack) or a usable credential,
// and cursorReadiness answers both in the order that names the right fix.
const CURSOR_ADAPTER: AgentAdapter<"cursor"> = {
    runtime: "cursor",
    oneShot: cursorOneShot,
    preflight: (services, input, context, granted) => planCursorTurn(services, input, context, granted),
    health: async (services) => {
        const readiness = await attemptProbe(() => cursorReadiness(services.cursorStore));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    // Asked of the SDK, not the filesystem: the local store is pluggable and the daemon doesn't own its layout. Listed,
    // not fetched: Agent.get is cloud-only and would misreport a resumable session as gone; no pack answers false
    // correctly.
    holdsSession: async (_services, sessionId, cwd) => {
        const sdk = await cursorSdk();
        if (sdk === undefined) {
            return false;
        }
        return sdk.Agent.list({ runtime: "local", cwd })
            .then((result) => result.items.some((agent) => agent.agentId === sessionId))
            .catch(() => false);
    },
};

export const cursorProvider: ProviderModule = {
    id: "cursor",
    accounts: cursorAccountDoor,
    adapters: [CURSOR_ADAPTER],
    catalog: (services) => services.cursorModels.models(),
    // Not a translator question, unlike other ready rungs: there's no translator route to Cursor, so its SDK is the
    // door and the credential is a key this sandbox owns. An expired key reads as not-ready: a turn on it would be
    // refused.
    ready: async (services) =>
        (await services.cursorStore.credentials()).some((account) => account.apiKeyExpiresAtMs === undefined || account.apiKeyExpiresAtMs > Date.now()),
    // Started unconditionally, not gated on the Cursor pack: there's no process to ENOENT on, just a socket and two
    // files, a few KB on an image with none. So the gate is armed the moment a pack installs, not only after the next
    // restart.
    boot: (services, role, logger) => {
        if (role.container) {
            void services.cursorHooks.start().catch((error: unknown) => logger.warn({ err: error }, "cursor command gate not started"));
        }
    },
    // @cursor/sdk can't ship in a published image (no-redistribution); Connect bootstraps it into the container,
    // surviving recreation. Reads the file-backed store, not a live probe: no runtime needed, survives the module being
    // absent.
    packs: async (services) => ((await readCursorCredentials(join(services.authRoot, "cursor"))).length > 0 ? ["cursor"] : []),
    secretEntries: async (services) =>
        (await services.cursorStore.list()).map((account) =>
            providerAccountEntry("cursor", "Cursor", account.id, account.label, authStateRelPath("cursor", `${account.id}.json`)),
        ),
};
