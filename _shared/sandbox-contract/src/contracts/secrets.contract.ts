import { procedure } from "../protocol/route-meta.js";
import {
    CredentialGateSchema,
    CredentialGuardSubjectParamSchema,
    CredentialGatesSchema,
    CredentialGrantSchema,
    CredentialPolicySchema,
    CredentialPolicySetSchema,
    CredentialRequestSchema,
    SecretInventorySchema,
    SecretKeyParamSchema,
    SecretGeneratedSchema,
    SecretGenerateSchema,
    SecretImportSchema,
    SecretRegenerateSchema,
    SecretHostGuardSetResultSchema,
    SecretHostGuardSetSchema,
    SecretHostGuardsSchema,
    SecretKeysSchema,
    SecretProgramGuardSetResultSchema,
    SecretProgramGuardSetSchema,
    SecretProgramGuardsSchema,
    SecretTypeIntoResultSchema,
    SecretTypeIntoSchema,
    SandboxKeyringPairResultSchema,
    SandboxKeyringPairSchema,
    SandboxKeyringsSchema,
    SecretRevealSchema,
    SecretSetSchema,
} from "../schemas/secrets.js";
import { SandboxNeedsSchema, SecretWantResultSchema, SecretWantSchema } from "../schemas/sandbox-passwords.js";
import { OkSchema } from "../schemas/shared.js";

// Credentials are the operating tier's, reads included: maintainer is the highest revokable grant, and no token's.
const secretRoute = procedure.meta({ floor: "maintainer", control: "never", right: "secrets" });
// The two that act on the owner's own computers (their keyrings, the window that has focus there): Secrets given to
// someone does not reach them, and the handlers hold them to the owner.
const ownerKeyringRoute = procedure.meta({ floor: "maintainer", control: "never" });

// User-supplied secrets, in the sandbox's own store; a set value resolves with no restart. `inventory` aggregates every
// store (never values) and always answers. `reveal` alone returns a value, owner-only, POST so the key avoids the URL.
export const secretsContract = {
    set: secretRoute
        .route({
            method: "POST",
            path: "/secrets",
            summary: "Store a secret",
            description:
                "Writes one name and value into the sandbox's own secret store, where the agent's references resolve it, without a restart.",
        })
        // A value put in place of the owner's: withheld from the panel token every panel process holds.
        .meta({ panel: false })
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
    importValue: secretRoute
        .route({
            method: "POST",
            path: "/secrets/import",
            summary: "Store a value under a new name",
            description:
                "Stores a value read from the `secrets import` command's input under a name nothing here holds yet, where `set` would have put it: how a value moves from where it lives now (another orchestrator's variables, a file on a server) without passing through the chat. Answers the name and its length, never the value. Refused for a name something here already holds, so it can add a credential and never replace one.",
        })
        // (2026-11-25) The `secrets import` CLI, on the agent token; withheld from the panel token, as `set` is.
        .meta({ agent: true, panel: false })
        .input(SecretImportSchema)
        .output(SecretGeneratedSchema),
    regenerate: secretRoute
        .route({
            method: "POST",
            path: "/secrets/regenerate",
            summary: "Replace a secret you set with a random value",
            description:
                "Replaces the value of a secret a person set here (not a connection's or a computer's) with a random one, for a value too short to hide from the model. Answers the name and its length, never the value. Whatever checks the old value (a server, an account) has to be given the new one, or it stops working.",
        })
        // Replaces a stored value, breaking whatever checks the old one: the owner's, never a panel process's.
        .meta({ panel: false })
        .input(SecretRegenerateSchema)
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
        // Removing a stored value is the owner's, never a panel process's.
        .meta({ panel: false })
        .input(SecretKeyParamSchema)
        .output(OkSchema),
    inventory: secretRoute
        .route({
            method: "GET",
            path: "/secrets/inventory",
            summary: "Every secret this sandbox holds, from everywhere",
            description:
                "One view across all the places secrets live here: what exists, where it came from and whether it is working. Never any values. This one always answers, even before anything has been stored.",
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
        // Who may release a credential is the owner's to say, never a panel process's.
        .meta({ panel: false })
        .input(CredentialGateSchema)
        .output(OkSchema),
    removeGate: secretRoute
        .route({
            method: "DELETE",
            path: "/secrets/gates/{subject}",
            summary: "Stop requiring approval for a credential",
            description: "Removes one gate, so the agent can use that credential the way it uses any other. The owner's call alone.",
        })
        // Lifting a gate is the owner's, never a panel process's.
        .meta({ panel: false })
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
    // The program guard, the host guard's counterpart for typing into windows on the owner's computers (schemas/secrets.ts
    // SecretProgramsSchema): read by the agent so a use aims where it may go; narrowing is anybody's, widening the owner's.
    programs: secretRoute
        .route({
            method: "GET",
            path: "/secrets/programs",
            summary: "Which programs each secret may be typed into",
            description:
                "Every sandbox-held secret whose program list is set: the programs on the owner's computers and the phone apps it goes into unasked. A secret held in a computer's keyring carries its own list, shown on its inventory row. Names and programs only, never values.",
        })
        .meta({ agent: true })
        .output(SecretProgramGuardsSchema),
    setPrograms: secretRoute
        .route({
            method: "PUT",
            path: "/secrets/programs/{subject}",
            summary: "Set which programs a secret may be typed into",
            description:
                "Replaces one sandbox-held secret's program list. Taking programs away, or turning `anyField` off, is open to anybody who may use secrets; adding one is the owner's: from the agent it raises a card for the owner in the live conversation and waits. Refused for a secret a computer's keyring holds, whose list is changed on that computer.",
        })
        .meta({ agent: true })
        .input(SecretProgramGuardSetSchema)
        .output(SecretProgramGuardSetResultSchema),
    // The owner's own Type into…, never the agent's: it types into whatever has focus, which only a person at that
    // computer can aim.
    typeInto: ownerKeyringRoute
        .route({
            method: "POST",
            path: "/secrets/type-into",
            summary: "Type a secret into the focused window on one of your computers",
            description:
                "After a short countdown, types one secret into whatever has focus on the computer named, through its keyring, which checks the window and still asks there when the entry's share says to. Answers what it went into, never the value.",
        })
        .meta({ panel: false })
        .input(SecretTypeIntoSchema)
        .output(SecretTypeIntoResultSchema),
    keyrings: secretRoute
        .route({
            method: "GET",
            path: "/secrets/keyrings",
            summary: "The keyrings on your computers",
            description:
                "Every connected computer with a keyring this sandbox can reach: whether it answers and is unlocked, how many of its entries are shared here, and whom it is paired with. Names and counts only, never values.",
        })
        .output(SandboxKeyringsSchema),
    keyringPair: ownerKeyringRoute
        .route({
            method: "POST",
            path: "/secrets/keyrings/pair",
            summary: "Pair the keyrings on two of your computers",
            description:
                "Asks each computer's keyring to pair with the other: each shows a prompt with both fingerprints, and only a yes on both pairs them. After that each keeps the other's entries in step, sealed between them and carried by this sandbox, which cannot open what it carries.",
        })
        .meta({ panel: false })
        .input(SandboxKeyringPairSchema)
        .output(SandboxKeyringPairResultSchema),
    // An agent's need, by place rather than by name (schemas/sandbox-passwords.ts): the owner's keyrings match it and ask.
    want: secretRoute
        .route({
            method: "POST",
            path: "/secrets/want",
            summary: "Ask the owner's computers for a credential by where it is used",
            description:
                "Asks each of the owner's computers with Passwords set up, most recently used first, for a credential that works at the place named (a site, a program, an ssh target, a git host). The person there is asked whether this sandbox may use it, and on what terms. Answers the name a reference uses once allowed, or that the answer is awaited in Passwords. Never a value.",
        })
        // The `secrets want` CLI and type_secret by place, on the agent token: it asks a person, and hands no value back.
        .meta({ agent: true })
        .input(SecretWantSchema)
        .output(SecretWantResultSchema),
    // The want's other half: what this sandbox asked for that still waits, drawn in the Secrets view's "Needs attention".
    wants: secretRoute
        .route({
            method: "GET",
            path: "/secrets/wants",
            summary: "Credentials this sandbox asked for that wait for an answer",
            description: "The credentials this sandbox asked the owner's computers for (`secrets want`) that nobody has answered yet, and on which computer each waits. Names and places only, never a value.",
        })
        .output(SandboxNeedsSchema),
    // The credential gateway's say over one connection: how its credential reaches the agent, and what it may do there.
    policy: secretRoute
        .route({
            method: "GET",
            path: "/secrets/policy/{subject}",
            summary: "How a connection's credential reaches the agent, and what it may do",
            description:
                "Whether the credential gateway holds this connection's credential or the agent is handed it, and the method and path rules the gateway enforces on every request it attaches it to. Names and rules only, never values.",
        })
        // The `secrets policy` CLI's read, on the agent token: knowing the rules lets a turn plan around them.
        .meta({ agent: true })
        .input(CredentialGuardSubjectParamSchema)
        .output(CredentialPolicySchema),
    setPolicy: secretRoute
        .route({
            method: "PUT",
            path: "/secrets/policy/{subject}",
            summary: "Set how a connection's credential reaches the agent, and its rules",
            description:
                "The owner's alone, and never the agent's: handing the agent the credential itself, or replacing what the gateway lets it do, is a decision about the credential, not a use of it.",
        })
        // Hands the agent a credential or rewrites its rules: never a panel process's.
        .meta({ panel: false })
        .input(CredentialPolicySetSchema)
        .output(CredentialPolicySchema),
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
