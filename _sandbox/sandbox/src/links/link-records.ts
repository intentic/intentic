import { type DiagnosticsAnswer, type DiagnosticsQuery, DiagnosticsQuerySchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { type ConversationReader, conversationReader, registryProvenance } from "../auth/scope/conversation-reader.js";
import type { Services } from "../composition.js";
import { createFleetReads } from "../conversations/recall/fleet-reads.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { runDiagnosticsQuery } from "../logs/diagnostics-queries.js";
import type { ResolvedLink } from "./inbound-links.js";
import { presentedLink } from "./link-door.js";

// A LINK'S RECORDS DOORS, the taking side: another of the owner's sandboxes reading this one's conversations, logs and
// diagnostics without starting a turn, for looking into a problem from there. Only while the link's terms share records
// (schemas/links.ts `records`), which its owner turns on here; every answer is one this sandbox already gives its own
// agents (`agents ls|find|show|bundle`, `diagnostics`), none can change anything, and each read is logged with the link.
//
// It reads as this sandbox's own tools do (conversation-reader.ts with no caller): every conversation but a private
// one, whoever's it is, since sharing records is the owner's choice for the whole sandbox.
//
// The reads themselves (`fleetReadAs`, `recordsDiagnostics`) are what a contact's records call answers too
// (links/contacts/contact-calls.ts), so the two ways in answer alike.

const NOT_SHARED =
    "This link does not share this sandbox's records. Its owner can turn that on where the link is listed: Access, Programs, Linked sandboxes.";

// One fleet read asked of the records: the roster or a search (no handle), one conversation, or its bundle, with the rest of
// its query as `agents ls|find|show` send it.
export interface FleetAsk {
    readonly handle?: string | undefined;
    readonly bundle?: boolean;
    readonly query?: Readonly<Record<string, string>> | undefined;
}

// A read's answer as its door gave it: the status and the JSON body, a refusal (no such conversation, an ambiguous handle
// with its candidates) included.
export interface RecordsAnswer {
    readonly status: number;
    readonly body: unknown;
}

/** What one read was, for the log line beside who read it. */
const recordsReadOf = (ask: FleetAsk): string => {
    if (ask.handle !== undefined) {
        return ask.bundle === true ? `bundle ${ask.handle}` : `show ${ask.handle}`;
    }
    const search = ask.query?.["q"];
    return search === undefined ? "roster" : `search "${search.slice(0, 80)}"`;
};

/**
 * One fleet read made with `reader`'s eyes, by the very handlers `agents ls|find|show|bundle` are served by
 * (conversations/recall/fleet-reads.ts), asked by path the way a request names them, so a caller with no request of its own
 * (a contact's records call) is answered exactly as a link door's request is.
 */
export const fleetReadAs = async (services: Services, reader: ConversationReader, ask: FleetAsk): Promise<RecordsAnswer> => {
    const reads = createFleetReads(services, async () => reader);
    const app = new Hono<AppEnv>().get("/fleet", reads.list).get("/fleet/:handle", reads.show).get("/fleet/:handle/bundle", reads.bundle);
    const path = ask.handle === undefined ? "/fleet" : `/fleet/${encodeURIComponent(ask.handle)}${ask.bundle === true ? "/bundle" : ""}`;
    const query = new URLSearchParams({ ...ask.query }).toString();
    const response = await app.request(`http://records.internal${path}${query === "" ? "" : `?${query}`}`);
    return { status: response.status, body: await response.json() };
};

/** One diagnostics query of this sandbox's records, as every records door answers it: the text and this sandbox's name. */
export const recordsDiagnostics = async (services: Pick<Services, "config" | "usage" | "info">, query: DiagnosticsQuery): Promise<DiagnosticsAnswer> => ({
    text: await runDiagnosticsQuery({ historyRoot: services.config.historyRoot, usage: services.usage }, query),
    sandbox: services.info?.name ?? "this sandbox",
});

/** Whose eyes a sandbox-wide records read is made with: this sandbox's own tools', every conversation but a private one. */
export const sandboxReader = (services: Pick<Services, "agents">): ConversationReader => conversationReader(undefined, registryProvenance(services.agents));

// A JSON answer at whatever status the read gave, which Hono's typed `c.json` will not take as a plain number.
const answered = ({ status, body }: RecordsAnswer): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The fleet read a link door's request names.
const askOf = (c: Context<AppEnv>, bundle: boolean): FleetAsk => ({ handle: c.req.param("handle"), bundle, query: c.req.query() });

export const linkRecordsRawRoutes = defineRawRoutes((services: Services) => {
    const doors = { links: services.inboundLinks, logger: services.logger };
    // The link the request presents, while it shares records; the refusal otherwise.
    const sharing = async (c: Context<AppEnv>, read: string): Promise<ResolvedLink | Response> => {
        const link = await presentedLink(doors, c);
        if (link instanceof Response) {
            return link;
        }
        if (!link.terms.records) {
            return c.json({ error: NOT_SHARED }, 403);
        }
        services.logger.info({ link: link.id, label: link.label, read }, "link: records read");
        return link;
    };
    const fleetRead =
        (bundle: boolean) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const ask = askOf(c, bundle);
            const link = await sharing(c, recordsReadOf(ask));
            return link instanceof Response ? link : answered(await fleetReadAs(services, sandboxReader(services), ask));
        };
    return {
        "GET /link/records/fleet": fleetRead(false),
        "GET /link/records/fleet/{handle}": fleetRead(false),
        "GET /link/records/fleet/{handle}/bundle": fleetRead(true),
        "POST /link/records/diagnostics": async (c: Context<AppEnv>): Promise<Response> => {
            // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
            const parsed = DiagnosticsQuerySchema.safeParse(await c.req.json().catch(() => undefined));
            const link = await sharing(c, parsed.success ? `diagnostics ${parsed.data.query}` : "diagnostics");
            if (link instanceof Response) {
                return link;
            }
            if (!parsed.success) {
                return c.json({ error: `not a diagnostics query: ${parsed.error.issues[0]?.message ?? "unreadable"}` }, 400);
            }
            return c.json(await recordsDiagnostics(services, parsed.data));
        },
    };
});
