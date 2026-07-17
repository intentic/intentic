import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import {
    CapabilitiesListSchema,
    CapabilityIdParamSchema,
    CapabilityLoginSchema,
    CapabilitySchema,
    CapabilitySecretInputSchema,
    CapabilityStatusSchema,
    MarketplaceRequestSchema,
    MarketplaceSchema,
    OkSchema,
} from "../schemas.js";

// The sandbox's unified capability manifest. `list` returns each active capability with its live status. `add`
// upserts a capability and STREAMS its apply (devops scaffolding / service provisioning emit ndjson progress;
// mcp/integration emit a terminal frame), mirroring the /intentic runner. `remove` tears it down (devops refuses
// — deleting the repos is data loss). `status` re-probes a single capability for a lazy UI refresh. `marketplace`
// resolves a Claude Code plugin marketplace repo into installable plugin-capability configs.
export const capabilitiesContract = {
    list: oc.route({ method: "GET", path: "/capabilities" }).output(CapabilitiesListSchema),
    add: oc.route({ method: "POST", path: "/capabilities" }).input(CapabilitySchema).output(eventIterator(IntenticLineSchema)),
    remove: oc.route({ method: "DELETE", path: "/capabilities/{id}" }).input(CapabilityIdParamSchema).output(OkSchema),
    // Replace just the secret in a capability's config (the /secrets page's edit) and re-run its apply.
    setSecret: oc.route({ method: "POST", path: "/capabilities/{id}/secret" }).input(CapabilitySecretInputSchema).output(OkSchema),
    status: oc.route({ method: "GET", path: "/capabilities/{id}/status" }).input(CapabilityIdParamSchema).output(CapabilityStatusSchema),
    marketplace: oc.route({ method: "POST", path: "/capabilities/marketplace" }).input(MarketplaceRequestSchema).output(MarketplaceSchema),
    // Start an agent-kind capability's interactive login (its declared loginCommand) in a visible terminal
    // session the user types into — device-code sign-in flows. Returns the session the panel attaches to.
    login: oc.route({ method: "POST", path: "/capabilities/{id}/login" }).input(CapabilityIdParamSchema).output(CapabilityLoginSchema),
};
