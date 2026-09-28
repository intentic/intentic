import { type FixtureRouter, Frames, refuse, servedProcedures } from "@intentic/contract-serve";
import { type Hello, type SystemEvent, TRANSLATOR_PROVIDERS, TranslatorAccountsSchema } from "@intentic/sandbox-contract";
import type { Grant } from "./grants.js";
import { readWindow } from "./files.js";
import { resolveExisting } from "./paths.js";
import { listChildren, walkTree } from "./walk.js";
import type { Watches } from "./watch.js";

// The contract's procedures a window on a folder needs, answered for that window's grant: the explorer's two reads, the
// text of a file, the event stream the editor holds open (its liveness, and what moved on disk), and the two extension
// reads the viewers activate with. Everything else the contract declares answers 404, and server.ts logs why.

// Liveness: the editor's watchdog drops a stream that goes quiet for ten seconds.
const HEARTBEAT_MS = 2_000;

// The one extension with settings the local face activates, and the engine it must use here: no Docker runs on this side.
const OFFICE_ID = `intentic.onlyoffice`;

// A folder holds no model accounts: every provider the contract knows, with none.
const NO_TRANSLATOR_ACCOUNTS = TranslatorAccountsSchema.parse(Object.fromEntries(TRANSLATOR_PROVIDERS.map((provider) => [provider, []])));

// What the editor's own chrome reads on every screen, whatever the screen shows: the fleet, model accounts, running apps,
// connected tools, personas, the review count. A folder has none of them, and says so rather than answering a 404 each
// one retries.
const NO_SANDBOX_CHROME = {
    agents: {
        list: () => ({ agents: [], rev: 0, held: [] }),
        archived: () => ({ agents: [], rev: 0, held: [] }),
    },
    agent: {
        refusals: () => ({ refusals: {} }),
        commands: () => ({ commands: [] }),
    },
    accounts: { accounts: () => ({ accounts: [] }) },
    translator: { accounts: () => NO_TRANSLATOR_ACCOUNTS },
    providers: {
        list: () => ({ native: [], agents: [], endpoints: [] }),
        models: () => ({ models: [], default: `` }),
    },
    usage: { refreshPlanLimits: () => ({ ok: true as const, held: [] }) },
    git: { changes: () => ({ repos: [], originAgents: {} }) },
    panels: { list: () => ({ panels: [] }) },
    capabilities: { list: () => ({ capabilities: [] }) },
    personas: { list: () => ({ personas: [], connected: [] }) },
    // No model trial runs through a folder.
    endpoints: { trial: () => ({ available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` as const }) },
} satisfies FixtureRouter;

export interface ProcedureContext {
    readonly watches: Watches;
    // Keys the editor's persisted cache, so an upgraded sidecar never hydrates what an older one answered.
    readonly build: string;
    readonly startedAt: number;
}

// What the hello frame says this side is: a folder, answering exactly these routes. The editor offers only what is
// listed (useDaemonRoutes.ts in the web app), so a verb a folder has no answer for (New Folder, Delete, a terminal) is
// not shown rather than refused. No payload fingerprints ride along, as they do from a daemon: the sidecar and the page
// that reads it ship in one build of the app.
type Advertised = Required<Pick<Hello, `routes` | `surface`>>;

const advertisedOf = (routes: readonly string[]): Advertised => ({ routes: [...routes].toSorted(), surface: `folder` });

// The event stream a window holds open: its liveness, and what moved on disk under its folder.
const eventsFor = (grant: Grant, context: ProcedureContext, advertised: Advertised): Frames<SystemEvent> =>
    new Frames<SystemEvent>((sink) => {
        sink.emit({
            kind: `hello`,
            workspaceId: `local-${grant.id}`,
            build: context.build,
            boot: { ready: true, startedAt: context.startedAt, steps: [] },
            ...advertised,
        });
        const beat = setInterval(() => sink.emit({ kind: `heartbeat`, rev: 0 }), HEARTBEAT_MS);
        const unsubscribe = context.watches.subscribe(grant.root, (paths) => sink.emit({ kind: `workspaceChanged`, paths: [...paths] }));
        return () => {
            clearInterval(beat);
            unsubscribe();
        };
    });

// Every procedure but the event stream, which advertises them.
const readsFor = (grant: Grant) =>
    ({
        ...NO_SANDBOX_CHROME,
        system: {
            // Nobody else looks at a folder on this computer.
            presence: () => ({ ok: true as const }),
        },
        workspace: {
            // A conversation's own copy exists only in a sandbox; asking for one here is asking for nothing.
            tree: ({ agent }) => (agent === undefined ? walkTree(grant.root) : refuse(`This folder has no conversations.`, 404)),
            children: ({ path, depth, agent }) =>
                agent === undefined ? listChildren(grant.root, path, depth) : refuse(`This folder has no conversations.`, 404),
            file: async ({ path, offset, limit, agent }) => {
                if (agent !== undefined) {
                    return refuse(`This folder has no conversations.`, 404);
                }
                const resolved = await resolveExisting(grant.root, path);
                if (resolved.kind === `refused`) {
                    return refuse(resolved.why, 400);
                }
                const window = resolved.kind === `found` ? await readWindow(resolved.abs, offset, limit) : undefined;
                return window === undefined ? { present: false as const, path } : { present: true as const, path, shared: true, ...window };
            },
        },
        extensions: {
            // Empty: which of its compiled-in extensions run is the local face's own choice (src/local in the web app).
            list: () => ({ extensions: [], invalid: [], pending: [] }),
            settings: ({ id }) => ({ settings: id === OFFICE_ID ? { engine: `browser` } : {}, secretsSet: [] }),
        },
    }) satisfies FixtureRouter;

// A window's procedures. `raw` names the routes it serves outside oRPC (raw.ts), which its hello advertises beside these.
export const proceduresFor = (grant: Grant, context: ProcedureContext, raw: readonly string[]) => {
    const reads = readsFor(grant);
    const advertised = advertisedOf([...servedProcedures(reads), `system.events`, ...raw]);
    return { ...reads, system: { ...reads.system, events: () => eventsFor(grant, context, advertised) } } satisfies FixtureRouter;
};
