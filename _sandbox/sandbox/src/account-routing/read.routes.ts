import { DiagnosticsQuerySchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import { personReader, registryProvenance } from "../auth/scope/conversation-reader.js";
import type { Services } from "../composition.js";
import { createFleetReads } from "../conversations/recall/fleet-reads.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { runDiagnosticsQuery } from "../logs/diagnostics-queries.js";
import { routeAdmissionOf } from "./admit-route.js";

/* ROUTING AS A PERSON, A READ (2026-11-24, docs/architecture/account-routing.md): another sandbox the person is in reading
 * this one's conversations and records as that person, without starting a turn: `agents ls|find|show|bundle --on` and
 * `diagnostics --on` over there. Admitted by a read pass beside their pairing (admit-route.ts), then answered with what
 * the fleet's own reads answer (fleet-reads.ts), cut to what THAT PERSON may read here: `visibleTo` for every tier, never
 * conversation-reader.ts's everything-for-a-maintainer shortcut, which also reads conversations the registry does not
 * know and other members' homes. Diagnostics are a maintainer's, as this sandbox's own logs are. Each read is logged with
 * the asking sandbox and the person. */

// What one read was, for the log line.
const readOf = (c: Context<AppEnv>): string => {
    const handle = c.req.param("handle");
    if (handle !== undefined) {
        return c.req.path.endsWith("/bundle") ? `bundle ${handle}` : `show ${handle}`;
    }
    const search = c.req.query("q");
    return search === undefined ? "roster" : `search "${search.slice(0, 80)}"`;
};

export const accountReadRawRoutes = defineRawRoutes((services: Services) => {
    const admitRoute = routeAdmissionOf(services);
    // The person a read goes as, admitted and logged; the refusal otherwise.
    const asPerson = async (c: Context<AppEnv>, read: string): Promise<Caller | Response> => {
        const admitted = await admitRoute(c, "read");
        if (admitted instanceof Response) {
            return admitted;
        }
        if (admitted.person === undefined) {
            return c.json({ error: "this read pass names no person", code: "pass" }, 401);
        }
        services.logger.info(
            { from: admitted.pass.from, fromName: admitted.pass.fromName, person: admitted.person.email, read },
            "account: records read as a person",
        );
        return admitted.person;
    };
    const fleetRead =
        (pick: (reads: ReturnType<typeof createFleetReads>) => (c: Context<AppEnv>) => Promise<Response>) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const person = await asPerson(c, readOf(c));
            if (person instanceof Response) {
                return person;
            }
            return pick(createFleetReads(services, async () => personReader(person, registryProvenance(services.agents))))(c);
        };
    return {
        "GET /account/read/agents": fleetRead((reads) => reads.list),
        "GET /account/read/agents/{handle}": fleetRead((reads) => reads.show),
        "GET /account/read/agents/{handle}/bundle": fleetRead((reads) => reads.bundle),
        "POST /account/read/diagnostics": async (c: Context<AppEnv>): Promise<Response> => {
            // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
            const parsed = DiagnosticsQuerySchema.safeParse(await c.req.json().catch(() => undefined));
            const person = await asPerson(c, parsed.success ? `diagnostics ${parsed.data.query}` : "diagnostics");
            if (person instanceof Response) {
                return person;
            }
            if (!tierAtLeast(person.tier, "maintainer")) {
                return c.json(
                    { error: `${person.email} may not read this sandbox's diagnostics: they are for its owner and its maintainers`, code: "floor" },
                    403,
                );
            }
            if (!parsed.success) {
                return c.json({ error: `not a diagnostics query: ${parsed.error.issues[0]?.message ?? "unreadable"}` }, 400);
            }
            const text = await runDiagnosticsQuery({ historyRoot: services.config.historyRoot, usage: services.usage }, parsed.data);
            return c.json({ text, sandbox: services.info?.name ?? "this sandbox" });
        },
    };
});
