import { errorMessage } from "@intentic/base/errors";
import { exitContract, type IntenticLine } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { exitDrivers } from "./exit-drivers.js";
import { checkExit, type ExitEntry, exitEntry, exitLink, exitLinks, rotateExit, startExit, stopExit } from "./exit-links.js";

// The live geo-exit routes. Adding an exit is a capability add; STARTING, MOVING and ROTATING one is here,
// because switching country is a runtime operation performed many times over one stored pool, by the operator
// from the capability card and by the agent through the `exit` CLI, which calls these same routes. Both therefore
// observe one implementation, and neither can move an exit without the other seeing it.

export type ExitRoutesDeps = Pick<Services, "capabilities">;

export const createExitRoutes = (services: ExitRoutesDeps) => {
    const i = implement(exitContract).$context<OrpcContext>();
    /* One move per exit at a time. Two concurrent starts would race the same interface, the same derived proxy
     * port and the same routing table and leave a half-built exit behind; worse, the loser's verification would
     * observe the winner's country and report a switch that never happened. Rejecting the second is honest,
     * the first is already streaming its progress. */
    const moving = new Set<string>();

    const entryOf = async (id: string): Promise<ExitEntry> => {
        const entry = await exitEntry(services.capabilities, id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no exit capability with that id` });
        }
        return entry;
    };

    /* start / use / rotate are one shape: hold the lock, stream the driver's progress, end with the link's own
     * state so the caller renders the verified address without a second round-trip, and surface a failure as
     * both an error frame and a thrown ORPCError, the stream's reader sees the message, the caller sees the
     * failure. Written once because the three differ only in which generator they run. */
    async function* move(id: string, run: (entry: ExitEntry) => AsyncGenerator<IntenticLine>): AsyncGenerator<IntenticLine> {
        const entry = await entryOf(id);
        if (moving.has(entry.id)) {
            throw new ORPCError("CONFLICT", { message: `"${entry.id}" is already moving, wait for it to finish` });
        }
        moving.add(entry.id);
        try {
            yield* run(entry);
            const link = await exitLink(entry);
            const where = [link.ip, link.observedCountry].filter((part) => part !== undefined).join(" · ");
            yield { kind: "log", message: `${link.id}: ${link.state}${where === "" ? "" : ` · ${where}`}` };
            yield { kind: "result", ok: true };
        } catch (error) {
            const message = errorMessage(error);
            yield { kind: "error", message };
            throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
        } finally {
            moving.delete(entry.id);
        }
    }

    return {
        list: i.list.handler(async () => ({ links: await exitLinks(services.capabilities) })),
        // What auto-fills the country picker. Live off the provider when it answers, from the baked fallback
        // when it does not, and `live` is passed through so the UI can say which rather than presenting a
        // stale list as current.
        countries: i.countries.handler(async ({ input }) => {
            const entry = await entryOf(input.id);
            const { countries, live } = await exitDrivers[entry.config.provider].catalog(entry.id, entry.config);
            return { countries: [...countries], live };
        }),
        start: i.start.handler(async function* ({ input }) {
            yield* move(input.id, (entry) => startExit(entry, entry.config.country));
        }),
        // The country the caller asked for, not the stored one. An absent country is meaningful, it means
        // "let the provider choose", so clearing a country is expressible rather than only setting one.
        use: i.use.handler(async function* ({ input }) {
            yield* move(input.id, (entry) => startExit(entry, input.country));
        }),
        rotate: i.rotate.handler(async function* ({ input }) {
            yield* move(input.id, (entry) => rotateExit(entry));
        }),
        check: i.check.handler(async ({ input }) => await checkExit(await entryOf(input.id))),
        stop: i.stop.handler(async ({ input }) => {
            await stopExit(await entryOf(input.id));
            return { ok: true } as const;
        }),
    };
};
