import { oc } from "@orpc/contract";
import { OkSchema, SecretInventorySchema, SecretKeyParamSchema, SecretKeysSchema, SecretRevealSchema, SecretSetSchema } from "../schemas.js";

// User-supplied env-var secrets, written to the sandbox's gitignored repositories/desired-state/.env (which
// `apply` reloads each run — no restart). `set` upserts one KEY=value, `remove` deletes it; `list` returns the
// keys present. `inventory` aggregates every secret store into one view (keys + status + provenance, never
// values). `reveal` is the single value-returning route — owner-only, POST so the key never sits in a URL.
// set/remove/list/reveal refuse until DevOps has scaffolded the desired-state repo; inventory always answers.
export const secretsContract = {
    set: oc.route({ method: "POST", path: "/secrets" }).input(SecretSetSchema).output(OkSchema),
    list: oc.route({ method: "GET", path: "/secrets" }).output(SecretKeysSchema),
    remove: oc.route({ method: "DELETE", path: "/secrets/{key}" }).input(SecretKeyParamSchema).output(OkSchema),
    inventory: oc.route({ method: "GET", path: "/secrets/inventory" }).output(SecretInventorySchema),
    reveal: oc.route({ method: "POST", path: "/secrets/reveal" }).input(SecretKeyParamSchema).output(SecretRevealSchema),
};
