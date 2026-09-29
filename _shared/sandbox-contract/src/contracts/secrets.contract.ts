import { procedure } from "../protocol/route-meta.js";
import {
    CredentialGateSchema,
    CredentialGuardSubjectParamSchema,
    CredentialGatesSchema,
    CredentialGrantSchema,
    CredentialRequestSchema,
    SecretInventorySchema,
    SecretKeyParamSchema,
    SecretGeneratedSchema,
    SecretGenerateSchema,
    SecretHostGuardSetResultSchema,
    SecretHostGuardSetSchema,
    SecretHostGuardsSchema,
    SecretKeysSchema,
    SecretRevealSchema,
    SecretSetSchema,
} from "../schemas/secrets.js";
import { OkSchema } from "../schemas/shared.js";

// Credentials are the operating tier's, reads included: maintainer is the highest revokable grant, and no token's.
const secretRoute = procedure.meta({ floor: "maintainer", control: "never" });

// User-supplied secrets, in the gitignored desired-state/.env once DevOps is active and the sandbox's own store before
// it; `apply` reloads them, no restart. `inventory` aggregates every store (never values) and always answers. `reveal` alone
// returns a value, owner-only, POST so the key avoids the URL.
export const secretsContract = {
    set: secretRoute
        .route({
            method: "POST",
            path: "/secrets",
            summary: "Store a secret",
            description:
                "Writes one name and value where the agent's references resolve it, without a restart: desired-state/.env once DevOps is active, the sandbox's own secret store before that.",
        })
        .input(SecretSetSchema)
        .output(OkSchema),
    generate: secretRoute
        .route({
            method: "POST",
            path: "/secrets/generate",
            summary: "Make and store a random secret",
            description:
                "Makes a random value and stores it under a new name, where `set` would have put it, for a secret nobody has to find or paste (a session key, a signing secret, a password the task sets up itself). Answers the name and its length, never the value. Refused for a name something here already holds.",
        })
        // The `secrets generate` CLI, on the agent token: it creates a value, and hands none back.
        .meta({ agent: true })
        .input(SecretGenerateSchema)
        .output(SecretGeneratedSchema),
    list: secretRoute
        .route({
            method: "GET",
            path: "/secrets",
            summary: "Names of the stored secrets",
            description: "Which secrets exist here. Names only, never values.",
        })
        .output(SecretKeysSchema),
    remove: secretRoute
        .route({
            method: "DELETE",
            path: "/secrets/{key}",
            summary: "Delete a secret",
            description: "Removes one by name.",
        })
        .input(SecretKeyParamSchema)
        .output(OkSchema),
    inventory: secretRoute
        .route({
            method: "GET",
            path: "/secrets/inventory",
            summary: "Every secret this sandbox holds, from everywhere",
            description:
                "One view across all the places secrets live here: what exists, where it came from and whether it is working. Never any values. This one always answers, even before there is a store to write to.",
        })
        .output(SecretInventorySchema),
    reveal: secretRoute
        .route({
            method: "POST",
            path: "/secrets/reveal",
            summary: "Show one secret's value",
            description:
                "The only call that hands a value back, and it is for the owner alone. Sent as a body rather than in the address, so the name never ends up in a log or a browser's history.",
        })
        // Hands a stored value back: withheld from the panel token every panel process holds.
        .meta({ panel: false })
        .input(SecretKeyParamSchema)
        .output(SecretRevealSchema),
    // Gate policy lives off the workspace, not in agent-editable `.intentic/config/`, so agents can't hold the key.
    gates: secretRoute
        .route({
            method: "GET",
            path: "/secrets/gates",
            summary: "Which credentials need somebody's approval",
            description:
                "What is gated and who may release it. Names and addresses only, never values, and the agent may read it too: knowing a credential needs Bob is what stops it concluding the account is simply not connected.",
        })
        // The `secrets` CLI's names-only reads and its ask, on the agent token; never a value.
        .meta({ agent: true })
        .output(CredentialGatesSchema),
    setGate: secretRoute
        .route({
            method: "PUT",
            path: "/secrets/gates/{subject}",
            summary: "Put a credential behind named approvers",
            description:
                "Names exactly who may release one secret or one connected account, and how far a single release goes. The owner's call alone. A signed-in browser or a mounted server cannot be released for one use, so those are always for the rest of the conversation.",
        })
        .input(CredentialGateSchema)
        .output(OkSchema),
    removeGate: secretRoute
        .route({
            method: "DELETE",
            path: "/secrets/gates/{subject}",
            summary: "Stop requiring approval for a credential",
            description: "Removes one gate, so the agent can use that credential the way it uses any other. The owner's call alone.",
        })
        .input(CredentialGuardSubjectParamSchema)
        .output(OkSchema),
    // The host guard, the gate's second half: kept beside the gates, off the agent-editable config for the same reason. The
    // agent reads it so a use can aim where it may go, and may tighten it; loosening waits for the owner's click.
    hosts: secretRoute
        .route({
            method: "GET",
            path: "/secrets/hosts",
            summary: "Which secrets are host-guarded, and where they may go",
            description:
                "Every secret and connected account whose host guard is set, on or off, and its hosts. With the guard on, a use aimed off the list, or anywhere a command's text does not show, asks a person first, whatever the safety judge says. Names and hosts only, never values.",
        })
        // The `secrets gates` and `secrets hosts` CLI's read, on the agent token.
        .meta({ agent: true })
        .output(SecretHostGuardsSchema),
    setHosts: secretRoute
        .route({
            method: "PUT",
            path: "/secrets/hosts/{subject}",
            summary: "Turn a secret's host guard on or off, and set its hosts",
            description:
                "Replaces one secret's host guard. Anybody who may use secrets can turn it on or take hosts away; turning it off or adding a host is the owner's: from the agent it raises a card for the owner in the live conversation and waits for their answer.",
        })
        // The `secrets hosts` CLI's edits, on the agent token; the route itself decides what needs the owner.
        .meta({ agent: true })
        .input(SecretHostGuardSetSchema)
        .output(SecretHostGuardSetResultSchema),
    request: secretRoute
        .route({
            method: "POST",
            path: "/secrets/request",
            summary: "Ask a named person to release a credential",
            description:
                "Raises the release card in the live conversation and waits for one of the people named on it. Refused, rather than held, when there is nobody to ask: an unattended turn, no live conversation, or a click with no verified identity behind it.",
        })
        .meta({ agent: true })
        .input(CredentialRequestSchema)
        .output(CredentialGrantSchema),
};
