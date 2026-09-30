import { type FixtureRouter, Frames, refuse, servedProcedures } from "@intentic/contract-serve";
import { type Hello, type SystemEvent, TRANSLATOR_PROVIDERS, TranslatorAccountsSchema } from "@intentic/sandbox-contract";
import { toRelPath } from "@intentic/workspace-ignore";
import type { DerivedTexts } from "./derived.js";
import type { Grant } from "./grants.js";
import { readWindow } from "./files.js";
import { resolveExisting, within } from "./paths.js";
import { resolveIn, searchFolder } from "./search.js";
import { type Ask, treeVerbsFor } from "./tree-verbs.js";
import { listChildren, walkTree } from "./walk.js";
import type { Watches } from "./watch.js";

// The contract's procedures a window on a folder needs, answered for that window's grant: the explorer's reads and its
// four verbs (tree-verbs.ts), the text of a file, search and the lookup of a written path (search.ts), a document's
// text for the quick look (derived.ts), the event stream the editor holds open (its liveness, and what moved on disk),
// and the two extension reads the viewers activate with. Everything else the contract declares answers 404, and
// server.ts logs why.

// Liveness: the editor's watchdog drops a stream that goes quiet for ten seconds.
const HEARTBEAT_MS = 2_000;

// The one extension with settings the local face activates, and how it runs here: the browser engine, since no Docker
// runs on this side, and a document opened to read first, with editing one click away (the viewer's Edit button).
const OFFICE_ID = `intentic.onlyoffice`;
const OFFICE_SETTINGS = { engine: `browser`, openAs: `view` };

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
    // Asks the app for what only it may do: a delete, which goes to the system's trash (asks.ts).
    readonly ask: Ask;
    // Documents' text for the quick look, kept in the app's cache.
    readonly derived: DerivedTexts;
}

// What the hello frame says this side is: a folder, answering exactly these routes. The editor offers only what is
// listed (useDaemonRoutes.ts in the web app), so a verb a folder has no answer for (a terminal, a ZIP) is not shown
// rather than refused. No payload fingerprints ride along, as they do from a daemon: the sidecar and the page that reads
// it ship in one build of the app.
type Advertised = Required<Pick<Hello, `routes` | `surface`>>;

const TREE_VERBS = [`workspace.move`, `workspace.copy`, `workspace.mkdir`, `workspace.delete`];

// The routes a grant answers only by refusing, which its hello leaves out so the editor never offers them: a document
// opened on its own changes nothing beside itself, and a read-only window changes nothing at all.
const refusedWhole = (grant: Grant): ReadonlySet<string> =>
    new Set([...(grant.file !== undefined || grant.readOnly === true ? TREE_VERBS : []), ...(grant.readOnly === true ? [`POST /workspace/upload`] : [])]);

const advertisedOf = (grant: Grant, routes: readonly string[]): Advertised => {
    const refused = refusedWhole(grant);
    return { routes: routes.filter((route) => !refused.has(route)).toSorted(), surface: `folder` };
};

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
        // A document's text landing, as a daemon says it (`derivedChanged`): the text view that read `deriving` reloads.
        const unheard = context.derived.onLanded((abs) => {
            if (abs !== grant.root && within(grant.root, abs)) {
                sink.emit({ kind: `derivedChanged`, paths: [toRelPath(grant.root, abs)] });
            }
        });
        return () => {
            clearInterval(beat);
            unsubscribe();
            unheard();
        };
    });

const NO_CONVERSATIONS = `This folder has no conversations.`;

// Every procedure but the event stream, which advertises them.
const answersFor = (grant: Grant, context: ProcedureContext) =>
    ({
        ...NO_SANDBOX_CHROME,
        system: {
            // Nobody else looks at a folder on this computer.
            presence: () => ({ ok: true as const }),
        },
        workspace: {
            // A conversation's own copy exists only in a sandbox; asking for one here is asking for nothing.
            tree: ({ agent }) => (agent === undefined ? walkTree(grant.root) : refuse(NO_CONVERSATIONS, 404)),
            children: ({ path, depth, agent }) => (agent === undefined ? listChildren(grant.root, path, depth) : refuse(NO_CONVERSATIONS, 404)),
            file: async ({ path, offset, limit, agent }) => {
                if (agent !== undefined) {
                    return refuse(NO_CONVERSATIONS, 404);
                }
                const resolved = await resolveExisting(grant.root, path);
                if (resolved.kind === `refused`) {
                    return refuse(resolved.why, 400);
                }
                const window = resolved.kind === `found` ? await readWindow(resolved.abs, offset, limit) : undefined;
                return window === undefined ? { present: false as const, path } : { present: true as const, path, shared: true, ...window };
            },
            search: (query) => searchFolder(grant.root, query),
            resolve: ({ path, agent }) => (agent === undefined ? resolveIn(grant.root, path) : refuse(NO_CONVERSATIONS, 404)),
            derived: ({ path }) => context.derived.read(grant.root, path),
            derive: ({ path }) => context.derived.derive(grant.root, path),
            ...treeVerbsFor(grant, context.ask),
        },
        extensions: {
            // Empty: which of its compiled-in extensions run is the local face's own choice (src/local in the web app).
            list: () => ({ extensions: [], invalid: [], pending: [] }),
            settings: ({ id }) => ({ settings: id === OFFICE_ID ? OFFICE_SETTINGS : {}, secretsSet: [] }),
        },
    }) satisfies FixtureRouter;

// A window's procedures. `raw` names the routes it serves outside oRPC (raw.ts), which its hello advertises beside these.
export const proceduresFor = (grant: Grant, context: ProcedureContext, raw: readonly string[]) => {
    const answers = answersFor(grant, context);
    const advertised = advertisedOf(grant, [...servedProcedures(answers), `system.events`, ...raw]);
    return { ...answers, system: { ...answers.system, events: () => eventsFor(grant, context, advertised) } } satisfies FixtureRouter;
};
