import { exitContract, type IntenticLine } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { tunnelEntry } from "../tunnel/tunnel-links.js";
import { heldStream } from "../tunnel/tunnel-route.js";
import { exitDrivers } from "./exit-drivers.js";
import { checkExit, type ExitEntry, exitLink, exitLinks, rotateExit, startExit, stopExit } from "./exit-links.js";

// The live geo-exit routes. Adding an exit is a capability add; STARTING, MOVING and ROTATING one is here,
// because switching country is a runtime operation performed many times over one stored pool, by the operator
// from the capability card and by the agent through the `exit` CLI, which calls these same routes. Both therefore
// observe one implementation, and neither can move an exit without the other seeing it.

export type ExitRoutesDeps = Pick<Services, "capabilities">;

export const createExitRoutes = (services: ExitRoutesDeps) => {
    const i = implement(exitContract).$context<OrpcContext>();
    // One move per exit at a time (tunnel-route.ts): here the loser's verification would additionally observe
    // the winner's country and report a switch that never happened.
    const moving = new Set<string>();

    const entryOf = async (id: string): Promise<ExitEntry> => {
        const entry = await tunnelEntry(services.capabilities, "exit", id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no exit capability with that id` });
        }
        return entry;
    };

    // start / use / rotate differ only in which generator they run.
    async function* move(id: string, run: (entry: ExitEntry) => AsyncGenerator<IntenticLine>): AsyncGenerator<IntenticLine> {
        const entry = await entryOf(id);
        yield* heldStream(
            moving,
            entry.id,
            "moving",
            () => run(entry),
            async () => {
                const link = await exitLink(entry);
                const where = [link.ip, link.observedCountry].filter((part) => part !== undefined).join(" · ");
                return `${link.id}: ${link.state}${where === "" ? "" : ` · ${where}`}`;
            },
        );
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
