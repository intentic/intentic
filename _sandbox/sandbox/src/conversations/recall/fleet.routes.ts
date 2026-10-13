import { type HandleResolution,candidateOf,fleetRecall,fleetRoster,fleetSearch,present,type RosterOptions } from "./fleet-recall.js";
import { type ConversationReader, conversationReader, registryProvenance } from "../../auth/scope/conversation-reader.js";
import type { Context } from "hono";
import { z } from "zod";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { soleLiveConversation } from "../actor/conversation-holdings.js";
import { messageConversation } from "./fleet-message.js";
import { resolveFleetHandle } from "./fleet-handles.js";
import { fleetMessageDetail, fleetMessages, fleetRows } from "./fleet-transcript.js";

// The shell door onto the daemon's fleet knowledge (registry, record, worktree composition, phrase index), joined into
// one answer. Its own namespace, not `/agents`: the board's router can land, discard and rename, so what lives here
// costs one grants.ts line each and cannot reach those. Serves a CLI parsing JSON, not a typed client.
//
// Reads, and exactly one write: `message`, which says something to another conversation the way a person does by
// typing into its chat (fleet-message.ts). It can start a turn, so it is rate-limited and attributed there; it cannot
// land, archive, rename or discard anything.

// Cap on a roster or search page; a caller asking for everything still gets a bounded answer.
const MAX_LIMIT = 100;

// Ceiling on one message: a peer needs a paragraph or two, not a file. Anything longer is a file to point at.
const MAX_MESSAGE_CHARS = 8_000;

const MessageBodySchema = z.object({
    to: z.string().min(1),
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
});

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
    return {
        ...(flagQuery(c, "all") === true ? { all: true } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(repo === undefined || repo === "" ? {} : { repo }),
        ...(owner === undefined || owner === "" ? {} : { owner }),
    };
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
const readableHandle = (resolved: HandleResolution, reads: ConversationReader): HandleResolution => {
    if (resolved.kind === "ambiguous") {
        const candidates = resolved.candidates.filter((candidate) => reads(candidate.id));
        return candidates.length === 0 ? { kind: "unknown" } : { ...resolved, candidates };
    }
    return resolved.kind === "unknown" || reads(resolved.entry.id) ? resolved : { kind: "unknown" };
};

// Full Services, not a Pick: `message` starts turns, and a turn is the whole daemon.
export const createFleetRoutes = (services: Services) => ({
    /** GET /fleet: paginated roster, newest first; `?q=` switches it to a phrase search, `?owner=` narrows to one member's. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const query = c.req.query("q")?.trim();
        const options = rosterOptionsOf(c);
        const found = query === undefined || query === "" ? fleetRoster(services, options) : await fleetSearch(services, query, options);
        // Only the conversations this caller may read: a row is a title, and a search hit a line of the transcript.
        const reads = conversationReader(c.get("identity"), registryProvenance(services.agents));
        const agents = found.filter((row) => reads(row.id));
        // `indexing` marks a backfill still running, so an empty result may still grow rather than mean nothing exists;
        // `coverage` says how far through the conversations that pass has got.
        if (query === undefined || query === "") {
            return c.json({ agents });
        }
        const coverage = services.saidIndex.coverage?.();
        return c.json({ agents, indexing: services.saidIndex.indexing(), ...present({ coverage }) });
    },
    /** GET /fleet/:handle: one conversation, whole; `?transcript=1` adds the record, bounded by `last` and `grep`
     *  (`&raw=1` as stored rows rather than lines); `?message=<n>` adds that one message whole, as `detail`;
     *  `?stored=1` adds what the daemon keeps for it, raw: its row in every table and the files in its directory. */
    show: async (c: Context<AppEnv>): Promise<Response> => {
        const handle = c.req.param("handle") ?? "";
        const reads = conversationReader(c.get("identity"), registryProvenance(services.agents));
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
            return c.json({ ok: false, message: `No conversation answers to \`${handle}\`. Search for one with \`agents find "<text>"\`.` }, 404);
        }
        const recall = await fleetRecall(services, resolved.entry, services.config.historyRoot, flagQuery(c, "diff") === false ? { diff: false } : {});
        // How a handle that is none of its own names led here (a retired session, a subagent), said once with the answer.
        const answer = { agent: recall, ...present({ via: resolved.via }) };
        if (flagQuery(c, "stored") === true) {
            return c.json({ ...answer, stored: await storedState(services, resolved.entry.id) });
        }
        const at = positionQuery(c, "message");
        if (at !== undefined) {
            const message = await fleetMessageDetail(services, resolved.entry, at);
            return message === undefined
                ? c.json({ ok: false, message: `${recall.id} has ${recall.digest.messages} messages, numbered from 0; there is no message ${at}.` }, 404)
                : c.json({ ...answer, detail: message });
        }
        if (flagQuery(c, "transcript") !== true) {
            return c.json(answer);
        }
        const last = numberQuery(c, "last", MAX_LIMIT);
        const grep = c.req.query("grep");
        const window = { ...(last === undefined ? {} : { last }), ...(grep === undefined || grep === "" ? {} : { grep }) };
        const transcript = flagQuery(c, "raw") === true ? await fleetRows(services, resolved.entry, window) : await fleetMessages(services, resolved.entry, window);
        return c.json({ ...answer, transcript });
    },
    /** POST /fleet/message: say something to another conversation — steered into its live turn, or opening one. */
    message: async (c: Context<AppEnv>): Promise<Response> => {
        const parsed = MessageBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'Pass JSON like {"to": "<handle>", "message": "…"}.' }, 400);
        }
        // Same attribution the children routes use: the turn's own stamp, else the one turn in flight.
        const from = c.req.header("x-intentic-conversation") ?? soleLiveConversation(services.conversations);
        const outcome = await messageConversation(services, from === "" ? undefined : from, parsed.data.to, parsed.data.message);
        return outcome.ok
            ? c.json(outcome)
            : c.json(
                  {
                      ok: false,
                      message: outcome.message,
                      ...(outcome.candidates === undefined
                          ? {}
                          : { candidates: outcome.candidates.map(candidateOf) }),
                  },
                  outcome.status,
              );
    },
});
