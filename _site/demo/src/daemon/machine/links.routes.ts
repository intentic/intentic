import { type RawRoutes, refuse } from "@intentic/contract-serve";
import { InboundLinkMintSchema, InboundLinkTermsUpdateSchema, LinkRequestDecisionSchema } from "@intentic/sandbox-contract/schemas/links";
import { json } from "../../transport";
import { decideRequest, linksList, mintLink, revokeLink, updateLink } from "./linkStore";

// Linked sandboxes: a link offered, answered, ended, and a request on one settled, against the store of the sandbox the
// call was sent to (daemon/linkStore.ts), so the list reads what its writes left. Bodies are parsed here, as the daemon's
// routes parse them, and refused whole. Spread into daemon/raw.ts's table.

type Parsed<T> = { readonly success: true; readonly data: T } | { readonly success: false; readonly error: { readonly message: string } };
const accepted = <T>(parsed: Parsed<T>): T => (parsed.success ? parsed.data : refuse(parsed.error.message, 400));

export const linksRoutes = {
    "GET /system/links": ({ url }) => json(linksList(url)),
    "POST /system/links": async ({ request, url }) => json(mintLink(url, accepted(InboundLinkMintSchema.safeParse(await request.json())))),
    "POST /system/links/{id}": async ({ request, url, param }) =>
        json(updateLink(url, param(`id`), accepted(InboundLinkTermsUpdateSchema.safeParse(await request.json())))),
    "DELETE /system/links/{id}": ({ url, param }) => json(revokeLink(url, param(`id`))),
    "POST /system/links/{id}/requests/{request}": async ({ request, url, param }) =>
        json(decideRequest(url, param(`id`), param(`request`), accepted(LinkRequestDecisionSchema.safeParse(await request.json())))),
} satisfies RawRoutes;
