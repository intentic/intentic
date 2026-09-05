import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { fleetMessages, fleetRecall, fleetRoster, fleetSearch, resolveHandle, type RosterOptions } from "./fleet-recall.js";

/* THE FLEET READ SURFACE the `agents ls|show|find` verbs drive (bin/agents), the shell door onto what the
 * daemon already knows about every conversation in this workspace: the registry, the per-conversation record,
 * the worktree composition and the phrase index, joined and answered once.
 *
 * WHY ITS OWN NAMESPACE rather than opening `/agents` to the agent token. That router is the BOARD's, and its
 * verbs land, discard, archive, rename and put words in an agent's mouth — presses that belong to the owner
 * and to a browser holding their bearer. Widening a grant to reach the two reads on it would have admitted the
 * mutations beside them to the same allowlist check forever after, one regex away from a mistake nobody would
 * notice. Two routes that can only read cost one line each in auth/grants.ts and cannot grow teeth.
 *
 * NOTHING HERE IS PRIVILEGED. Every byte these answer is already on the history volume, readable by the turn
 * that asks: the measured behaviour this replaces is agents reading exactly these files by hand, badly and
 * expensively (see fleet-recall.ts). What changes is the cost, not the reach — no credential, no secret, and
 * no way to write.
 *
 * PLAIN HONO, like children.routes.ts, and registered before the oRPC catch-all: these serve a CLI that speaks
 * `node:http` and parses JSON, not a typed browser client. */

export type FleetRoutesDeps = Pick<Services, "agents" | "agentWorktrees" | "transcripts" | "saidIndex" | "config">;

// A caller asking for everything gets a page, not the whole fleet: 1 900 conversations is what this workspace
// holds today, and an answer that size is one nobody reads and everybody pays for.
const MAX_LIMIT = 100;

const numberQuery = (c: Context<AppEnv>, name: string, max: number): number | undefined => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === "") {
        return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, max) : undefined;
};

// A flag is on when it is present with anything but the shapes people write for "off". Deliberately generous:
// this is read by hand from a shell, where `?all=1`, `?all=true` and `?all` all plainly mean the same thing.
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
    return {
        ...(flagQuery(c, "all") === true ? { all: true } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(repo === undefined || repo === "" ? {} : { repo }),
    };
};

export const createFleetRoutes = (services: FleetRoutesDeps) => ({
    /** GET /fleet — the roster, most recently active first; `?q=` makes it a search over what was said. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const query = c.req.query("q")?.trim();
        const options = rosterOptionsOf(c);
        const agents = query === undefined || query === "" ? fleetRoster(services, options) : await fleetSearch(services, query, options);
        /* `indexing` is the honest half of a search answer, the /agents/search rule: while the backfill is
         * still working the phrase index does not yet hold everything this workspace said, so a caller that
         * found nothing is told the answer can still grow rather than concluding nothing exists. */
        return c.json({ agents, ...(query === undefined || query === "" ? {} : { indexing: services.saidIndex.indexing() }) });
    },
    /** GET /fleet/:handle — one conversation, whole; `?transcript=1` adds the record, bounded by `last`/`grep`. */
    show: async (c: Context<AppEnv>): Promise<Response> => {
        const handle = c.req.param("handle") ?? "";
        const resolved = resolveHandle(services, handle);
        if (resolved.kind === "ambiguous") {
            /* NAMED, NEVER PICKED. Answering with one of several conversations that answer to a half-spelled
             * handle is the failure this whole surface exists to end: the caller reads about the wrong agent
             * and has no way to find out. 409 because the request is answerable — it just is not yet one
             * question — and the candidates ride along so the next call is a copy-paste away. */
            return c.json(
                {
                    ok: false,
                    message: `\`${handle}\` matches ${resolved.candidates.length} conversations; name one of them.`,
                    candidates: resolved.candidates.map((entry) => ({ id: entry.id, title: entry.title, status: entry.status, updatedAt: entry.updatedAt })),
                },
                409,
            );
        }
        if (resolved.kind === "unknown") {
            return c.json({ ok: false, message: `No conversation answers to \`${handle}\`. Search for one with \`agents find "<text>"\`.` }, 404);
        }
        const recall = await fleetRecall(services, resolved.entry, services.config.historyRoot, (flagQuery(c, "diff") === false ? { diff: false } : {}));
        if (flagQuery(c, "transcript") !== true) {
            return c.json({ agent: recall });
        }
        const last = numberQuery(c, "last", MAX_LIMIT);
        const grep = c.req.query("grep");
        const transcript = await fleetMessages(services, resolved.entry, {
            ...(last === undefined ? {} : { last }),
            ...(grep === undefined || grep === "" ? {} : { grep }),
        });
        return c.json({ agent: recall, transcript });
    },
});
