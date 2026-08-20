import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import {
    CapabilitiesListSchema,
    CapabilityCardParamSchema,
    CapabilityConnectionSchema,
    CapabilityIdParamSchema,
    CapabilityLoginSchema,
    CapabilityOtpSchema,
    CapabilityRenameSchema,
    CapabilitySchema,
    CapabilitySecretInputSchema,
    CapabilityStatusSchema,
    MarketplaceRequestSchema,
    MarketplaceSchema,
    OkSchema,
} from "../schemas.js";

/* The sandbox's unified capability manifest. `list` returns each active capability with its live status, the
 * non-secret echo of its config, and the NAMES of the credentials it holds. `add` upserts a capability and
 * STREAMS its apply (devops scaffolding / service provisioning emit ndjson progress; mcp/integration emit a
 * terminal frame), mirroring the /intentic runner. `remove` tears it down (devops refuses, deleting the repos
 * is data loss). `status` re-probes a single capability for a lazy UI refresh. `marketplace` resolves a Claude
 * Code plugin marketplace repo into installable plugin-capability configs.
 *
 * `add` IS ALSO THE EDIT, because the write is an upsert: the same id with a changed config changes that
 * connection. A caller editing one has never been shown its credentials, so it sends VAULTED
 * (capability-secrets.ts) for each it is leaving alone and the daemon resolves those from what is stored before
 * anything runs, the only way to change one setting on a tunnel without re-typing its key. A marker with
 * nothing behind it is refused rather than written. */
export const capabilitiesContract = {
    list: oc.route({ method: "GET", path: "/capabilities" }).output(CapabilitiesListSchema),
    add: oc.route({ method: "POST", path: "/capabilities" }).input(CapabilitySchema).output(eventIterator(IntenticLineSchema)),
    remove: oc.route({ method: "DELETE", path: "/capabilities/{id}" }).input(CapabilityIdParamSchema).output(OkSchema),
    /* Give a connection a different name, carrying what the old one keyed: a browser profile with its logins,
     * a connected machine's enrollment, an extension's checkout. The name is the agent's handle for the thing,
     * so this is a migration, add + remove would lose exactly the state that makes the connection worth
     * keeping. A kind whose name is part of what it IS (the scaffolders, the one-per-sandbox cards) refuses. */
    rename: oc.route({ method: "POST", path: "/capabilities/{id}/rename" }).input(CapabilityRenameSchema).output(OkSchema),
    // Replace just the secret in a capability's config (the /secrets page's edit) and re-run its apply.
    setSecret: oc.route({ method: "POST", path: "/capabilities/{id}/secret" }).input(CapabilitySecretInputSchema).output(OkSchema),
    status: oc.route({ method: "GET", path: "/capabilities/{id}/status" }).input(CapabilityIdParamSchema).output(CapabilityStatusSchema),
    /* One capability's stored config, secrets included, how an extension BACKEND dials the service behind a
     * connected capability (ext-deployments reads its Komodo's key pair through this). Never a browser's: the
     * handler refuses any caller with a member identity, so only the daemon's header grants reach it, and an
     * extension's grant reaches it only when its manifest declares the route in `permissions.daemon`, which
     * is the install dialog saying, in one line, "this extension can read connected credentials". */
    connection: oc.route({ method: "GET", path: "/capabilities/{id}/connection" }).input(CapabilityIdParamSchema).output(CapabilityConnectionSchema),
    marketplace: oc.route({ method: "POST", path: "/capabilities/marketplace" }).input(MarketplaceRequestSchema).output(MarketplaceSchema),
    // "Not needed": stop offering this card until the workspace evidence behind it changes. Nothing is torn
    // down and nothing is remembered about the card itself, only the evidence it was declined against.
    dismiss: oc.route({ method: "DELETE", path: "/capabilities/recommendations/{card}" }).input(CapabilityCardParamSchema).output(OkSchema),
    // Start an agent-kind capability's interactive login (its declared loginCommand) in a visible terminal
    // session the user types into, device-code sign-in flows. Returns the session the panel attaches to.
    login: oc.route({ method: "POST", path: "/capabilities/{id}/login" }).input(CapabilityIdParamSchema).output(CapabilityLoginSchema),
    // Mint one TOTP code from the capability's stored seed (a field its card marks `totp`). The one capability
    // read the agent token is admitted to (see auth/grants): a code expires within its period and never reveals
    // the seed, so the in-sandbox `otp` command can answer a 2FA prompt without the agent holding the factor.
    otp: oc.route({ method: "GET", path: "/capabilities/{id}/otp" }).input(CapabilityIdParamSchema).output(CapabilityOtpSchema),
};
