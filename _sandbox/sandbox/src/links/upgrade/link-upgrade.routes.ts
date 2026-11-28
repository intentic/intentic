import { LINK_HEADER } from "@intentic/sandbox-contract/schemas/links";
import { S2sLinkUpgradeRequestSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { InboundLinks } from "../inbound-links.js";
import { presentedLink } from "../link-door.js";
import { type LinkUpgradeInDeps, linkUpgradeIn } from "./link-upgrade-in.js";

// `POST /link/upgrade` (link-upgrade-in.ts): the link's own token, then the asking sandbox's identity document. A token
// already upgraded is admitted here alone, and only for a while, to read the answer it got again; every other link door
// refuses it, and so does this one once that while is over.

// An identity document and room around it.
const BODY_MAX = 64 * 1024;

export interface LinkUpgradeRouteDeps extends LinkUpgradeInDeps {
    readonly links: Pick<InboundLinks, "resolve" | "touch" | "resolveUpgraded" | "upgrade">;
    readonly logger: Pick<Logger, "warn">;
}

// The refusal a token nothing here answers for reads, whether it never was one, was revoked, or retired long enough ago.
const UNKNOWN = "This link is not one this sandbox holds: it was revoked, or never minted here. Its owner can link the two sandboxes again.";

export const linkUpgradeRoute = (deps: LinkUpgradeRouteDeps) => {
    const upgrade = linkUpgradeIn(deps);
    return async (c: Context<AppEnv>): Promise<Response> => {
        const presented = c.req.header(LINK_HEADER) ?? "";
        if ((await deps.links.resolveUpgraded(presented)) === undefined) {
            const link = await presentedLink(deps, c);
            if (link instanceof Response) {
                return link;
            }
        }
        const read = await readBoundedJson(c.req.raw, BODY_MAX);
        const parsed = read.kind === "ok" ? S2sLinkUpgradeRequestSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "an upgrade carries the asking sandbox's identity: {document, grants?, wake?}", code: "malformed" }, 400);
        }
        const answer = await upgrade(presented, parsed.data);
        if (answer === "unknown") {
            return c.json({ error: UNKNOWN }, 401);
        }
        if ("refused" in answer) {
            return c.json({ error: answer.refused, code: "code" in answer ? answer.code : "not_contact" }, answer.status);
        }
        return c.json(answer);
    };
};

export const linkUpgradeRawRoutes = defineRawRoutes((services: Pick<Services, "s2s" | "inboundLinks" | "contactTasks" | "logger">) => ({
    "POST /link/upgrade": linkUpgradeRoute({ core: services.s2s.core, links: services.inboundLinks, book: services.contactTasks, logger: services.logger }),
}));
