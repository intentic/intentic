import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { fleetMessages, fleetRecall, fleetRoster, fleetSearch, resolveHandle, type RosterOptions } from "./fleet-recall.js";

// The shell door onto the daemon's fleet knowledge (registry, record, worktree composition, phrase index), joined into
// one answer. Its own namespace, not `/agents`: the board's router can land, discard and rename, so a read-only route
// here costs one grants.ts line and cannot grow teeth. Serves a CLI parsing JSON, not a typed client.

export type FleetRoutesDeps = Pick<Services, "agents" | "agentWorktrees" | "transcripts" | "saidIndex" | "config">;

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
    return {
        ...(flagQuery(c, "all") === true ? { all: true } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(repo === undefined || repo === "" ? {} : { repo }),
    };
};

export const createFleetRoutes = (services: FleetRoutesDeps) => ({
    /** GET /fleet: paginated roster, newest first; `?q=` switches it to a phrase search. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const query = c.req.query("q")?.trim();
        const options = rosterOptionsOf(c);
        const agents = query === undefined || query === "" ? fleetRoster(services, options) : await fleetSearch(services, query, options);
        // `indexing` marks a backfill still running, so an empty result may still grow rather than mean nothing exists.
        return c.json({ agents, ...(query === undefined || query === "" ? {} : { indexing: services.saidIndex.indexing() }) });
    },
    /** GET /fleet/:handle: one conversation, whole; `?transcript=1` adds the record, bounded by `last` and `grep`. */
    show: async (c: Context<AppEnv>): Promise<Response> => {
        const handle = c.req.param("handle") ?? "";
        const resolved = resolveHandle(services, handle);
        if (resolved.kind === "ambiguous") {
            // Named, never picked: 409 because the request is answerable, just not unique.
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
