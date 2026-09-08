import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events/system-events.js";
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
} from "../schemas/capabilities.js";
import { MarketplaceRequestSchema, MarketplaceSchema } from "../schemas/marketplace.js";
import { OkSchema } from "../schemas/shared.js";

// The sandbox's unified capability manifest, spanning `list`/`add`/`remove`/`status`/`marketplace`. A VAULTED marker
// with nothing stored behind it is refused rather than silently written.
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
    // A credential the caller is keeping arrives as VAULTED here too, so an edit can be tested without retyping a key.
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
    // Called by the /secrets page's edit action.
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
    // Gated by `permissions.daemon` in the manifest (ext-deployments reads its Komodo key pair this way).
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
    // Runs the capability's declared `loginCommand` in the terminal session the panel attaches to.
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
    // The seed comes from the config field the card marks `totp`.
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
