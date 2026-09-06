import { oc } from "@orpc/contract";
import {
    CredentialGateSchema,
    CredentialGateSubjectParamSchema,
    CredentialGatesSchema,
    CredentialGrantSchema,
    CredentialRequestSchema,
    SecretInventorySchema,
    SecretKeyParamSchema,
    SecretKeysSchema,
    SecretRevealSchema,
    SecretSetSchema,
} from "../schemas/secrets.js";
import { OkSchema } from "../schemas/shared.js";

// User-supplied env-var secrets, written to the sandbox's gitignored desired-state/.env (which
// `apply` reloads each run, no restart). `set` upserts one KEY=value, `remove` deletes it; `list` returns the
// keys present. `inventory` aggregates every secret store into one view (keys + status + provenance, never
// values). `reveal` is the single value-returning route, owner-only, POST so the key never sits in a URL.
// set/remove/list/reveal refuse until DevOps has scaffolded the desired-state repo; inventory always answers.
export const secretsContract = {
    set: oc
        .route({
            method: "POST",
            path: "/secrets",
            summary: "Store a secret",
            description:
                "Writes one name and value into the sandbox's own store, where running processes pick it up without a restart. Refused until the sandbox has somewhere to keep them.",
        })
        .input(SecretSetSchema)
        .output(OkSchema),
    list: oc
        .route({
            method: "GET",
            path: "/secrets",
            summary: "Names of the stored secrets",
            description: "Which secrets exist here. Names only, never values.",
        })
        .output(SecretKeysSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/secrets/{key}",
            summary: "Delete a secret",
            description: "Removes one by name.",
        })
        .input(SecretKeyParamSchema)
        .output(OkSchema),
    inventory: oc
        .route({
            method: "GET",
            path: "/secrets/inventory",
            summary: "Every secret this sandbox holds, from everywhere",
            description:
                "One view across all the places secrets live here: what exists, where it came from and whether it is working. Never any values. This one always answers, even before there is a store to write to.",
        })
        .output(SecretInventorySchema),
    reveal: oc
        .route({
            method: "POST",
            path: "/secrets/reveal",
            summary: "Show one secret's value",
            description:
                "The only call that hands a value back, and it is for the owner alone. Sent as a body rather than in the address, so the name never ends up in a log or a browser's history.",
        })
        .input(SecretKeyParamSchema)
        .output(SecretRevealSchema),
    /* THE APPROVAL GATES, four routes with three different audiences, which is why they are worth reading as a
     * group.
     *
     * `gates` is READ BY EVERYONE who needs to explain the sandbox to itself: the Secrets view draws a badge
     * from it, and the AGENT is allowed it too (auth/grants.ts), because a model that cannot see which
     * credentials are gated cannot tell "not connected" from "needs Bob", and the difference decides whether
     * its next move is to ask a person or to go looking for another road. It answers names, subjects and
     * approver addresses; there is nothing else in it to leak.
     *
     * `setGate` and `removeGate` are the OWNER's alone, enforced in-route with authorizeOwner rather than by
     * the /secrets role floor, because the floor is maintainer and a maintainer is exactly who a gate is
     * sometimes written about. The policy lives off the workspace beside the credential vault for the same
     * reason the vault does: `.intentic/config/` is tracked and agent-editable, so a gate stored there would
     * be a lock whose key is in the room with the agent.
     *
     * `request` is the AGENT's door, and the only one of the four that can park a turn: it raises the release
     * card and waits, so a gated account can be asked for rather than merely discovered to be absent. */
    gates: oc
        .route({
            method: "GET",
            path: "/secrets/gates",
            summary: "Which credentials need somebody's approval",
            description:
                "What is gated and who may release it. Names and addresses only, never values, and the agent may read it too: knowing a credential needs Bob is what stops it concluding the account is simply not connected.",
        })
        .output(CredentialGatesSchema),
    setGate: oc
        .route({
            method: "PUT",
            path: "/secrets/gates/{subject}",
            summary: "Put a credential behind named approvers",
            description:
                "Names exactly who may release one secret or one connected account, and how far a single release goes. The owner's call alone. A signed-in browser or a mounted server cannot be released for one use, so those are always for the rest of the conversation.",
        })
        .input(CredentialGateSchema)
        .output(OkSchema),
    removeGate: oc
        .route({
            method: "DELETE",
            path: "/secrets/gates/{subject}",
            summary: "Stop requiring approval for a credential",
            description: "Removes one gate, so the agent can use that credential the way it uses any other. The owner's call alone.",
        })
        .input(CredentialGateSubjectParamSchema)
        .output(OkSchema),
    request: oc
        .route({
            method: "POST",
            path: "/secrets/request",
            summary: "Ask a named person to release a credential",
            description:
                "Raises the release card in the live conversation and waits for one of the people named on it. Refused, rather than held, when there is nobody to ask: an unattended turn, no live conversation, or a click with no verified identity behind it.",
        })
        .input(CredentialRequestSchema)
        .output(CredentialGrantSchema),
};
