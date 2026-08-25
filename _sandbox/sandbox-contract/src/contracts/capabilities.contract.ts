import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import {
    CapabilitiesListSchema,
    CapabilityCardParamSchema,
    CapabilityConnectionSchema,
    CapabilityIdParamSchema,
    CapabilityLoginSchema,
    CapabilityOtpSchema,
    CapabilityProbeSchema,
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
    list: oc
        .route({
            method: "GET",
            path: "/capabilities",
            summary: "Everything this sandbox is connected to",
            description:
                "Each connection with its live state, the settings that are safe to show, and the names of the credentials it holds. The values of those credentials are never in the answer, on any route but one.",
        })
        .output(CapabilitiesListSchema),
    add: oc
        .route({
            method: "POST",
            path: "/capabilities",
            summary: "Connect something, or change a connection",
            description:
                "Writes a connection and streams the work of applying it, because some kinds provision real infrastructure and take a while. Sending an id that already exists edits that connection: this is the edit as well as the create. Since a caller is never shown stored credentials, it marks the ones it is leaving alone and the daemon fills them in, which is the only way to change one setting without retyping a key.",
        })
        .input(CapabilitySchema)
        .output(eventIterator(IntenticLineSchema)),
    /* TRY THE SETTINGS BEFORE SAVING THEM. Nothing is written and nothing is applied: the daemon dials the
     * service the way the connection would and hands back what it said. It exists because the alternative is
     * the form's only feedback being the card afterwards reading "not connected", which names none of the six
     * answers that could have been wrong. A credential the caller is keeping arrives as VAULTED here too, so
     * an edit can be tested without re-typing a key. */
    probe: oc
        .route({
            method: "POST",
            path: "/capabilities/probe",
            summary: "Test a connection's settings without saving them",
            description:
                "Dials the service the way this connection would and hands back what it said, before anything is written. The answer is the service's own confirmation or its exact refusal, so a wrong token or an unreachable host is found on the form rather than on a card afterwards.",
        })
        .input(CapabilitySchema)
        .output(CapabilityProbeSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/capabilities/{id}",
            summary: "Disconnect something",
            description:
                "Tears a connection down. The kinds that own real infrastructure refuse, because deleting those would be losing data rather than losing a connection.",
        })
        .input(CapabilityIdParamSchema)
        .output(OkSchema),
    /* Give a connection a different name, carrying what the old one keyed: a browser profile with its logins,
     * a connected machine's enrollment, an extension's checkout. The name is the agent's handle for the thing,
     * so this is a migration, add + remove would lose exactly the state that makes the connection worth
     * keeping. A kind whose name is part of what it IS (the scaffolders, the one-per-sandbox cards) refuses. */
    rename: oc
        .route({
            method: "POST",
            path: "/capabilities/{id}/rename",
            summary: "Rename a connection",
            description:
                "Carries everything the old name keyed across with it: a browser profile and its logins, an enrolled machine, an extension's copy of its source. Removing and re-adding would lose exactly the state that made the connection worth keeping. Kinds whose name is part of what they are refuse.",
        })
        .input(CapabilityRenameSchema)
        .output(OkSchema),
    // Replace just the secret in a capability's config (the /secrets page's edit) and re-run its apply.
    setSecret: oc
        .route({
            method: "POST",
            path: "/capabilities/{id}/secret",
            summary: "Replace a stored credential",
            description: "Swaps one connection's key or token for a new one and re-applies it, without touching any of its other settings.",
        })
        .input(CapabilitySecretInputSchema)
        .output(OkSchema),
    status: oc
        .route({
            method: "GET",
            path: "/capabilities/{id}/status",
            summary: "Re-check one connection",
            description: "Probes a single connection right now, for a screen that wants to refresh one row rather than the whole list.",
        })
        .input(CapabilityIdParamSchema)
        .output(CapabilityStatusSchema),
    /* One capability's stored config, secrets included, how an extension BACKEND dials the service behind a
     * connected capability (ext-deployments reads its Komodo's key pair through this). Never a browser's: the
     * handler refuses any caller with a member identity, so only the daemon's header grants reach it, and an
     * extension's grant reaches it only when its manifest declares the route in `permissions.daemon`, which
     * is the install dialog saying, in one line, "this extension can read connected credentials". */
    connection: oc
        .route({
            method: "GET",
            path: "/capabilities/{id}/connection",
            summary: "A connection's settings, credentials included",
            description:
                "The one call that hands back stored secrets, so an extension's own backend can dial the service behind a connection. Never answered for a signed-in person: only a machine credential reaches it, and an extension's only if its manifest asked for this route out loud at install time.",
        })
        .input(CapabilityIdParamSchema)
        .output(CapabilityConnectionSchema),
    marketplace: oc
        .route({
            method: "POST",
            path: "/capabilities/marketplace",
            summary: "Read a plugin marketplace",
            description: "Resolves a plugin marketplace source into the list of connections you could install from it.",
        })
        .input(MarketplaceRequestSchema)
        .output(MarketplaceSchema),
    // "Not needed": stop offering this card until the workspace evidence behind it changes. Nothing is torn
    // down and nothing is remembered about the card itself, only the evidence it was declined against.
    dismiss: oc
        .route({
            method: "DELETE",
            path: "/capabilities/recommendations/{card}",
            summary: "Stop suggesting this connection",
            description:
                "Not needed, for now. Nothing is torn down. The suggestion comes back if what prompted it in the workspace changes, because what is remembered is the evidence, not the refusal.",
        })
        .input(CapabilityCardParamSchema)
        .output(OkSchema),
    // Start an agent-kind capability's interactive login (its declared loginCommand) in a visible terminal
    // session the user types into, device-code sign-in flows. Returns the session the panel attaches to.
    login: oc
        .route({
            method: "POST",
            path: "/capabilities/{id}/login",
            summary: "Sign in to a connection by hand",
            description:
                "Opens the connection's own sign-in in a terminal a person can type into, for the flows that need a code pasted or a device confirmed. The answer names the terminal to attach to.",
        })
        .input(CapabilityIdParamSchema)
        .output(CapabilityLoginSchema),
    // Mint one TOTP code from the capability's stored seed (a field its card marks `totp`). The one capability
    // read the agent token is admitted to (see auth/grants): a code expires within its period and never reveals
    // the seed, so the in-sandbox `otp` command can answer a 2FA prompt without the agent holding the factor.
    otp: oc
        .route({
            method: "GET",
            path: "/capabilities/{id}/otp",
            summary: "Mint a one-time code",
            description:
                "Generates a single two-factor code from a stored seed. The one credential-adjacent read an agent is allowed, and it is safe because a code expires in seconds and never reveals the seed, so an agent can answer a prompt without ever holding the factor.",
        })
        .input(CapabilityIdParamSchema)
        .output(CapabilityOtpSchema),
};
