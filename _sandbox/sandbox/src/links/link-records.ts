import { DiagnosticsQuerySchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { conversationReader, registryProvenance } from "../auth/scope/conversation-reader.js";
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

const NOT_SHARED =
    "This link does not share this sandbox's records. Its owner can turn that on where the link is listed: Access, Programs, Linked sandboxes.";

// What one read was, for the log line beside the link's name.
const readOf = (c: Context<AppEnv>): string => {
    const handle = c.req.param("handle");
    const search = c.req.query("q");
    if (handle !== undefined) {
        return c.req.path.endsWith("/bundle") ? `bundle ${handle}` : `show ${handle}`;
    }
    return search === undefined ? "roster" : `search "${search.slice(0, 80)}"`;
};

export const linkRecordsRawRoutes = defineRawRoutes((services: Services) => {
    const doors = { links: services.inboundLinks, logger: services.logger };
    const reads = createFleetReads(services, async () => conversationReader(undefined, registryProvenance(services.agents)));
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
    const behind =
        (read: (c: Context<AppEnv>) => Promise<Response>) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const link = await sharing(c, readOf(c));
            return link instanceof Response ? link : read(c);
        };
    return {
        "GET /link/records/fleet": behind(reads.list),
        "GET /link/records/fleet/{handle}": behind(reads.show),
        "GET /link/records/fleet/{handle}/bundle": behind(reads.bundle),
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
            const text = await runDiagnosticsQuery({ historyRoot: services.config.historyRoot, usage: services.usage }, parsed.data);
            return c.json({ text, sandbox: services.info?.name ?? "this sandbox" });
        },
    };
});
