import { LINK_HEADER } from "@intentic/sandbox-contract/schemas/links";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { InboundLinks, ResolvedLink } from "./inbound-links.js";

// The one check every link door makes first (links.routes.ts, link-records.ts): the token the request presents, as the
// link it was minted for.

export interface LinkDoorDeps {
    readonly links: Pick<InboundLinks, "resolve" | "touch">;
    readonly logger: Pick<Logger, "warn">;
}

// The link this request presents, or the refusal: a token nothing here was minted as, or one since revoked, reads the
// same, since telling them apart would tell a stranger which tokens once worked.
export const presentedLink = async (deps: LinkDoorDeps, c: Context<AppEnv>): Promise<ResolvedLink | Response> => {
    const link = await deps.links.resolve(c.req.header(LINK_HEADER) ?? "");
    if (link === undefined) {
        return c.json({ error: "This link is not one this sandbox holds: it was revoked, or never minted here. Its owner can link the two sandboxes again." }, 401);
    }
    void deps.links.touch(link.id).catch((error: Error) => deps.logger.warn({ err: error, link: link.id }, "link: last use not recorded"));
    return link;
};

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };

// A link door's JSON body read through its schema; a body that is not JSON reads as none, which the schema then refuses
// by name.
export const linkBody = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<Parsed<T>> => {
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(raw ?? {});
    if (parsed.success) {
        return { ok: true, value: parsed.data };
    }
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    return { ok: false, response: c.json({ error: `${where}${issue?.message ?? "the body did not read as the route's input"}` }, 400) };
};
