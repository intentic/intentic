import { oc } from "@orpc/contract";
import { OkSchema, SecretInventorySchema, SecretKeyParamSchema, SecretKeysSchema, SecretRevealSchema, SecretSetSchema } from "../schemas.js";

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
};
