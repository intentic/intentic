import { opt } from "../../opt.js";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { ConversationReader } from "../../auth/scope/conversation-reader.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { ROSTER } from "../actor/subagent-roster.js";
import { type BundlePromptReader, conversationBundle } from "./fleet-bundle.js";
import { resolveFleetHandle } from "./fleet-handles.js";
import { type HandleResolution, candidateOf, fleetRecall, fleetRosterPage, fleetSearchPage, present, type RosterOptions } from "./fleet-recall.js";
import { fleetMessageDetail, fleetMessages, fleetRows } from "./fleet-transcript.js";
import { fleetLoopOf, UNLANDED_HOURS, unlandedBefore, withLoops } from "./fleet-left-off.js";
import { indexedPath, worktreesRootOf } from "./fleet-overlap.js";

// The fleet's READS, apart from the routes that serve them (fleet.routes.ts for this sandbox's own agents, and a link's
// records doors, links/link-records.ts, for another sandbox reading this one): the roster or a phrase search, one
// conversation whole, and one conversation's debug bundle. Each is made with the reader its door supplies, and none can
// change anything.

// Cap on a roster or search page; a caller asking for everything still gets a bounded answer.
const MAX_LIMIT = 100;

const numberQuery = (c: Context<AppEnv>, name: string, max: number): number | undefined => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === "") {
        return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, max) : undefined;
};

// A message's position in the record, counted from 0 as the transcript's `at` prints it.
const positionQuery = (c: Context<AppEnv>, name: string): number | undefined => {
    const raw = c.req.query(name);
    if (raw === undefined || !/^\d+$/u.test(raw)) {
        return undefined;
    }
    return Number.parseInt(raw, 10);
};

// On for any value but an explicit off (`0`, `false`, `no`); generous, since these are typed by hand from a shell.
const flagQuery = (c: Context<AppEnv>, name: string): boolean | undefined => {
    const raw = c.req.query(name);
    if (raw === undefined) {
        return undefined;
    }
    return raw !== "0" && raw !== "false" && raw !== "no";
};

const rosterOptionsOf = (c: Context<AppEnv>): RosterOptions => {
    const limit = numberQuery(c, "limit", MAX_LIMIT);
    const repo = c.req.query("repo");
    const owner = c.req.query("owner");
    // `?unlanded=<hours>`: only work stopped and never landed for at least that long (fleet-left-off.ts).
    const unlanded = numberQuery(c, "unlanded", MAX_UNLANDED_HOURS);
    return present({
        all: flagQuery(c, "all") === true ? true : undefined,
        limit,
        repo: repo === "" ? undefined : repo,
        owner: owner === "" ? undefined : owner,
        unlandedBefore: unlanded === undefined ? undefined : unlandedBefore(unlanded, Date.now()),
    });
};

// A year: past it, every stopped conversation is forgotten anyway.
const MAX_UNLANDED_HOURS = 24 * 365;

// How much work sits stopped and never landed for a day or more, on a roster read that is not already asking for it, so
// `agents ls` says it is there; undefined when none does.
const forgottenOf = (services: Services, options: RosterOptions, reads: ConversationReader): { readonly hours: number; readonly count: number } | undefined => {
    if (options.unlandedBefore !== undefined) {
        return undefined;
    }
    const count = fleetRosterPage(services, { ...present({ all: options.all }), unlandedBefore: unlandedBefore(UNLANDED_HOURS, Date.now()), limit: 1 }, reads).total;
    return count === 0 ? undefined : { hours: UNLANDED_HOURS, count };
};

// How many of a conversation's files a stored read lists; the count past it says how many more there are.
const STORED_FILES = 200;

// Everything the daemon keeps for one conversation, as stored: its rows by table and its directory's files.
const storedState = async (services: Pick<Services, "conversationsDb" | "conversationUnits">, id: string) => ({
    rows: services.conversationsDb.rowsOf(id),
    unit: { dir: services.conversationUnits.dir(id), ...(await services.conversationUnits.files(id, STORED_FILES)) },
});

// A handle as this caller may follow it: a conversation it may not read answers as no conversation at all, and an
// ambiguous handle names only the candidates it may read, so neither says what lies behind the fence.
export const readableHandle = (resolved: HandleResolution, reads: ConversationReader): HandleResolution => {
    if (resolved.kind === "ambiguous") {
        const candidates = resolved.candidates.filter((candidate) => reads(candidate.id));
        return candidates.length === 0 ? { kind: "unknown" } : { ...resolved, candidates };
    }
    return resolved.kind === "unknown" || reads(resolved.entry.id) ? resolved : { kind: "unknown" };
};

// Whose eyes a read is made with: the turn or person asking here (turn-reader.ts), or a link sharing this sandbox's
// records (links/link-records.ts).
export type FleetReaderOf = (c: Context<AppEnv>) => Promise<ConversationReader>;

// A spawned child whose first turn has not begun (waiting for room, a seat or the owner) has no conversation yet, only its
// row on its parent's roster: said with where it stands, not as no such conversation, since a child that has not started
// is the one a parent most needs to look up (2026-11-19).
const unstartedChild = (services: Pick<Services, "conversations">, handle: string, reads: ConversationReader): string | undefined => {
    const row = services.conversations.holdings(ROSTER).get(handle);
    if (row?.kind !== "spawned" || !reads(row.conversationId)) {
        return undefined;
    }
    const standing = row.summary === undefined || row.summary === "" ? row.status : `${row.status}: ${row.summary}`;
    return `\`${handle}\` is a subagent of \`${row.conversationId}\` that has not started yet, so it has no conversation to show. It is ${standing}`;
};

// A handle as the caller may follow it, or the refusal it is answered with.
const resolvedFor = async (
    services: Services,
    c: Context<AppEnv>,
    reads: ConversationReader,
): Promise<{ readonly entry: PersistedAgent; readonly via?: string } | Response> => {
    const handle = c.req.param("handle") ?? "";
    const resolved = readableHandle(await resolveFleetHandle(services, handle), reads);
    if (resolved.kind === "ambiguous") {
        // Named, never picked: 409 because the request is answerable, just not unique.
        return c.json(
            {
                ok: false,
                message: `\`${handle}\` matches ${resolved.candidates.length} conversations; name one of them.`,
                candidates: resolved.candidates.map(candidateOf),
            },
            409,
        );
    }
    if (resolved.kind === "unknown") {
        const message = unstartedChild(services, handle, reads) ?? `No conversation answers to \`${handle}\`. Search for one with \`agents find "<text>"\`.`;
        return c.json({ ok: false, message }, 404);
    }
    return { entry: resolved.entry, ...present({ via: resolved.via }) };
};

// The fleet's reads, made with whichever reader the door supplies: the roster or a search, one conversation, and one
// conversation's debug bundle. None can change anything.
export const createFleetReads = (services: Services, readerOf: FleetReaderOf, readPrompt?: BundlePromptReader) => ({
    /** GET /fleet: paginated roster, newest first; `?q=` switches it to a phrase search, `?owner=` narrows to one member's. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const query = c.req.query("q")?.trim();
        // `?touching=` names a path as the asking shell saw it; the index keys it workspace-relative (fleet-overlap.ts).
        const touching = c.req.query("touching");
        const options = {
            ...rosterOptionsOf(c),
            ...present({ touching: touching === undefined || touching === "" ? undefined : indexedPath(touching, services.workspace.root, worktreesRootOf(services.agentWorktrees)) }),
        };
        // Only the conversations this caller may read, kept before the page is cut: a row is a title, and a search hit a
        // line of the transcript.
        const reads = await readerOf(c);
        const page = query === undefined || query === "" ? fleetRosterPage(services, options, reads) : await fleetSearchPage(services, query, options, reads);
        // `total` and `truncated` say whether this page is the whole answer (2026-11-17, the shinobi-society audit: a page
        // cut at its limit read as the whole fleet). `limit` stops at MAX_LIMIT; past it, `--repo`, `--owner` or a search
        // narrows instead.
        const agents = page.rows;
        const counted = { total: page.total, truncated: page.total > agents.length, maxLimit: MAX_LIMIT };
        // `indexing` marks a backfill still running, so an empty result may still grow rather than mean nothing exists;
        // `coverage` says how far through the conversations that pass has got.
        if (query === undefined || query === "") {
            // What each row's loop has got to, and how much stopped work never landed (fleet-left-off.ts).
            return c.json({ agents: withLoops(agents, await services.loops.list()), ...counted, ...present({ unlanded: forgottenOf(services, options, reads) }) });
        }
        const coverage = services.saidIndex.coverage?.();
        return c.json({ agents, ...counted, indexing: services.saidIndex.indexing(), ...present({ coverage }) });
    },
    /** GET /fleet/:handle: one conversation, whole; `?transcript=1` adds the record, bounded by `last` and `grep`
     *  (`&raw=1` as stored rows rather than lines); `?message=<n>` adds that one message whole, as `detail`;
     *  `?stored=1` adds what the daemon keeps for it, raw: its row in every table and the files in its directory. */
    show: async (c: Context<AppEnv>): Promise<Response> => {
        const resolved = await resolvedFor(services, c, await readerOf(c));
        if (resolved instanceof Response) {
            return resolved;
        }
        const recall = await fleetRecall(
            services,
            resolved.entry,
            services.config.historyRoot,
            flagQuery(c, "diff") === false ? { diff: false } : {},
        );
        // How a handle that is none of its own names led here (a retired session, a subagent), said once with the answer.
        const loop = await services.loops.get(resolved.entry.id);
        const answer = { agent: loop === undefined ? recall : { ...recall, loop: fleetLoopOf(loop) }, ...present({ via: resolved.via }) };
        if (flagQuery(c, "stored") === true) {
            return c.json({ ...answer, stored: await storedState(services, resolved.entry.id) });
        }
        const at = positionQuery(c, "message");
        if (at !== undefined) {
            const message = await fleetMessageDetail(services, resolved.entry, at);
            return message === undefined
                ? c.json(
                      { ok: false, message: `${recall.id} has ${recall.digest.messages} messages, numbered from 0; there is no message ${at}.` },
                      404,
                  )
                : c.json({ ...answer, detail: message });
        }
        if (flagQuery(c, "transcript") !== true) {
            return c.json(answer);
        }
        const last = numberQuery(c, "last", MAX_LIMIT);
        const grep = c.req.query("grep");
        const window = present({ last, grep: grep === "" ? undefined : grep });
        const transcript =
            flagQuery(c, "raw") === true ? await fleetRows(services, resolved.entry, window) : await fleetMessages(services, resolved.entry, window);
        return c.json({ ...answer, transcript });
    },
    /** GET /fleet/:handle/bundle: one conversation's debug bundle (fleet-bundle.ts), for a person or agent elsewhere. */
    bundle: async (c: Context<AppEnv>): Promise<Response> => {
        const resolved = await resolvedFor(services, c, await readerOf(c));
        if (resolved instanceof Response) {
            return resolved;
        }
        return c.json(await conversationBundle({ ...services, historyRoot: services.config.historyRoot, ...opt("readPrompt", readPrompt) }, resolved.entry));
    },
});
