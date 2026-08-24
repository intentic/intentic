import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { browserOutputDir } from "../browser/browser-artifacts.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { withAttachments } from "../agent/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import type { TurnContext, TurnPlan } from "../agent/turn-plan.js";
import type { Services } from "../composition.js";
import { turnPersona } from "../personas/personas.js";
import { createCursorAgent } from "./cursor-agent.js";
import { type CursorCatalog, createCursorCatalog } from "./cursor-catalog.js";
import { type CursorStore, fileCursorStore, usableCursorAccount } from "./cursor-credentials.js";
import { createCursorHookService, type CursorHookService } from "./cursor-hooks.js";
import { cursorReadiness } from "./cursor-readiness.js";
import { cursorSdk } from "./cursor-sdk.js";

/* EVERYTHING CURSOR CONTRIBUTES TO THE DAEMON, in one module the provider registry aggregates
 * (agent/provider-module.ts is the seam and the reasoning; this file is the first instance of it, written by
 * carving Cursor's rows OUT of the six shared tables they originally landed in).
 *
 * The directory's other files keep their jobs: this one holds only what the shared surfaces used to hold — the
 * turn arm, the adapter row, the service slice, and the answers the registry iterates. */

// The Services members Cursor contributes, declared here so composition merely spreads them and the members'
// documentation lives with the provider that owns them.
export interface CursorSlice {
    // Cursor subscription accounts (one <id>.json per account under .intentic/secrets/auth/cursor), several
    // per sandbox. The sandbox owns the credential outright: Cursor's sign-in mints a user API key and this
    // store is the only copy, so there is no vendor-side auth file the way OpenCode holds xAI's.
    readonly cursorStore: CursorStore;
    // Cursor's live model catalog, held directly as well as in the shared record for the reason Codex's is: a
    // Cursor turn MUST resolve a concrete model (the SDK has no default of its own) and it needs the vendor's
    // own parameter record for that id to translate an effort tier. Neither is a question the record asks.
    readonly cursorModels: CursorCatalog;
    // The socket-backed command gate Cursor's own runtime calls out to before it runs a shell command, and the
    // registry of which live turn each consult belongs to (cursor-hooks.ts). One per daemon, because the hooks
    // file that names it is machine-global.
    readonly cursorHooks: CursorHookService;
    // Cursor's runtime, run IN THIS PROCESS through @cursor/sdk rather than as a child, which is why it takes
    // no spawner and why its worktree isolation is by working directory (see the capability record).
    readonly cursorAgent: Services["agent"];
}

export const createCursorSlice = (input: { readonly authRoot: string; readonly logger: Logger }): CursorSlice => {
    const cursorStore = fileCursorStore(join(input.authRoot, "cursor"), input.logger);
    const cursorModels = createCursorCatalog(cursorStore, join(input.authRoot, "cursor", "models.json"));
    // The command gate, sited beside the credentials rather than in a temp dir: the socket is the authority to
    // answer a permission card, so it belongs in the one tree this workspace already treats as secret.
    const cursorHooks = createCursorHookService(join(input.authRoot, "cursor"), input.logger);
    return {
        cursorStore,
        cursorModels,
        cursorHooks,
        cursorAgent: createCursorAgent({ catalog: cursorModels, hooks: cursorHooks, logger: input.logger }),
    };
};

/* CURSOR ON ITS OWN RUNTIME, which is the only route to it: no translator serves Cursor, and Cursor publishes
 * no model endpoint a subscription can reach, so unlike codex/grok there is no harness fork to make here and
 * `capabilitiesOf` answers the same record either way.
 *
 * THE CREDENTIAL IS PICKED HERE AND CARRIED ON THE REQUEST, which is unlike every neighbour and is forced by
 * the runtime being IN-PROCESS. Codex gets a CODEX_HOME and OpenCode holds its own auth, because both are
 * separate processes with their own environments; Cursor's loop runs inside this daemon, where an environment
 * variable is a daemon-wide fact. So the account a turn was planned against rides the request as a key, and
 * every SDK call the adapter makes takes it explicitly.
 *
 * BROWSER SERVERS COME ALONG, which no other foreign runtime here manages: Cursor takes stdio MCP servers per
 * agent, so the same specs the Claude Code loop is handed are projected into its own config (cursor-tools.ts).
 * That is the difference between `mcp: "tools"` and Codex's `"browser"` being a real one rather than a claim. */
export const planCursorTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
    // One resolver, shared with the health probe, so the greyed-out tooltip and the refusal can never name
    // different reasons (cursor-readiness.ts).
    const readiness = await cursorReadiness(services.cursorStore);
    if (!readiness.ok) {
        return { ok: false, ...(readiness.code !== undefined ? { code: readiness.code } : {}), message: readiness.detail };
    }
    const account = await usableCursorAccount(services.cursorStore, input.account);
    if (account === undefined) {
        // Reachable only when the named account was disconnected between the readiness check and here, or when
        // the client pinned an id that never existed. Both are "pick another one", not "connect one".
        return { ok: false, message: "That Cursor account is no longer connected. Pick another one, or connect it again in Sandbox ▸ Agent." };
    }
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // The catalog is never empty, so this always resolves: keep the pinned model while the catalog still offers
    // it, else take the catalog's default. The SDK has no default of its own for a local agent, which makes
    // resolving here mandatory rather than merely tidy.
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
        // A real account id, unlike the routed providers' shared marker: this sandbox stores the credential
        // itself, so the usage and rate-limit frames can name exactly which connection paid.
        account: account.id,
        // The adapter folds attachment paths into the prompt as a file list; Cursor's read tool takes them off
        // disk, which is the same treatment OpenCode and Pi get.
        request: withAttachments(withBrowser, context.attachmentPaths),
    };
};

/* Cursor's own runtime, in this daemon's process. The one adapter with nothing to probe on PATH and no server
 * to reach: what can be missing is the SDK module (a pack, see cursor-sdk.ts) or a usable credential, and
 * cursorReadiness answers both in the order that names the right fix. */
const CURSOR_ADAPTER: AgentAdapter<"cursor"> = {
    runtime: "cursor",
    preflight: (services, input, context, granted) => planCursorTurn(services, input, context, granted),
    health: async (services) => {
        const readiness = await attemptProbe(() => cursorReadiness(services.cursorStore));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    /* A Cursor session is a row in the SDK's own local agent store, so the question is whether that store still
     * has it. Asked of the SDK rather than of the filesystem, because the store is pluggable (SQLite or JSONL,
     * and replaceable) and the daemon does not own its layout.
     *
     * LISTED RATHER THAN FETCHED, which looks like the long way round and is the only correct one: `Agent.get`
     * is documented cloud-only, so on a local id it does not answer "no such agent", it fails for a different
     * reason entirely — and a resume that IS possible would be reported as impossible on every turn.
     *
     * An image with no Cursor pack answers false, which is right rather than merely convenient: without the
     * runtime the resume could not happen whatever the store says. */
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

/* A Cursor turn needs `@cursor/sdk`, which is the one runtime that can NEVER be baked into a published image:
 * its licence grants no redistribution (see packs/cursor.Dockerfile). So this predicate is not merely how the
 * pack arrives on a core image, as it is for codex and opencode — it is the ONLY way the pack ever arrives
 * anywhere, and a user who connects a Cursor account and is not offered the rebuild has no other route.
 *
 * Read off the credential DIRECTORY rather than through the store's parser, the provider-packs rule: a live
 * probe would need the very module the pack installs. A directory with an account file in it is the fact on
 * disk, and it survives the binary being absent. */
const cursorConnected = async (services: Services): Promise<boolean> => {
    const entries = await readdir(join(services.authRoot, "cursor")).catch(() => [] as string[]);
    return entries.some((name) => name.endsWith(".json"));
};

export const cursorProvider: ProviderModule = {
    id: "cursor",
    adapters: [CURSOR_ADAPTER],
    catalog: (services) => services.cursorModels.models(),
    /* The only ready rung that is NOT a translator question, because there is no translator route to Cursor at
     * all: its own SDK is the one door, and the credential is a stored key this sandbox owns outright. A key
     * past its expiry reads as not-ready, since the turn that used it would be refused. */
    ready: async (services) =>
        (await services.cursorStore.credentials()).some((account) => account.apiKeyExpiresAtMs === undefined || account.apiKeyExpiresAtMs > Date.now()),
    /* The command gate: started unconditionally rather than gated on the Cursor pack being present, and the
     * asymmetry with the translator's binary gate is deliberate. That gate exists because spawning a missing
     * BINARY fails ENOENT into a restart ladder; there is no process here, only a listening socket and two
     * files, so the cost of arming it on an image with no Cursor is a few kilobytes. What it buys is that the
     * gate is already in place the moment a pack IS installed, rather than only after the next daemon restart —
     * an installed pack whose rules silently did not apply until a restart is the worst version of this. */
    boot: (services, role, logger) => {
        if (role.container) {
            void services.cursorHooks.start().catch((error: unknown) => logger.warn({ err: error }, "cursor command gate not started"));
        }
    },
    packs: async (services) => ((await cursorConnected(services)) ? ["cursor"] : []),
    secretEntries: async (services) =>
        (await services.cursorStore.list()).map((account) =>
            providerAccountEntry("cursor", "Cursor", account.id, account.label, authStateRelPath("cursor", `${account.id}.json`)),
        ),
};
