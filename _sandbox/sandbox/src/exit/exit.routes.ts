import { exitContract, type IntenticLine } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { tunnelEntry } from "../tunnel/tunnel-links.js";
import { heldStream } from "../tunnel/tunnel-route.js";
import { exitDrivers } from "./exit-drivers.js";
import { checkExit, type ExitEntry, exitLink, exitLinks, rotateExit, startExit, stopExit } from "./exit-links.js";

// Adding an exit is a capability add; starting, moving and rotating one lives here, since switching country is a
// runtime operation the operator (card) and the agent (`exit` CLI) both perform through these same routes, so neither
// can move an exit without the other seeing it.

export type ExitRoutesDeps = Pick<Services, "capabilities">;

export const createExitRoutes = (services: ExitRoutesDeps) => {
    const i = implement(exitContract).$context<OrpcContext>();
    // One move per exit at a time, or a losing verification could report a switch that never happened.
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
        // Fills the country picker: live from the provider when it answers, the baked fallback when it doesn't; `live`
        // says which so the UI doesn't present a stale list as current.
        countries: i.countries.handler(async ({ input }) => {
            const entry = await entryOf(input.id);
            const { countries, live } = await exitDrivers[entry.config.provider].catalog(entry.id, entry.config);
            return { countries: [...countries], live };
        }),
        start: i.start.handler(async function* ({ input }) {
            yield* move(input.id, (entry) => startExit(entry, entry.config.country));
        }),
        // The country the caller asked for, not the stored one; absent means "let the provider choose".
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
