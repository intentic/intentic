import { type Capability, TRIAL_ENDPOINT_ID } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Config } from "../env.config.js";
import type { TrialService } from "./trial.js";

/* THE TRIAL AS A CAPABILITY THE USER NEVER ADDED — provisioned by the daemon, and deliberately never written to
 * the manifest.
 *
 * It is a synthetic entry laid over the store rather than a row in .intentic/capabilities.json, and that is the
 * whole design. A persisted entry would be the user's to edit and delete, which is wrong in both directions: its
 * "API key" is this sandbox's connect token, so an editable card is a card that shows a credential and lets a
 * typo break the sandbox's identity to the platform; and a deleted entry would come back on the next boot,
 * which is a card that ignores the user. Neither is a thing a person should have to reason about for a trial
 * they will stop using the moment they connect an account.
 *
 * Synthetic also makes the lifecycle free. The trial exists exactly while the platform says it does — the
 * probe's answer IS the entry's existence — so a platform that turns the trial off, or an allowance that is
 * spent, needs no cleanup pass over a file. */

// The entry the rest of the daemon sees. `openai` protocol, so it rides the translator's openai-compatibility
// list like any other user-configured endpoint — which is what buys the trial the whole existing turn path.
const trialCapability = (config: Config): Capability => ({
    id: TRIAL_ENDPOINT_ID,
    kind: "endpoint",
    config: {
        baseUrl: new URL("/trial/v1", config.platform.url).toString(),
        protocol: "openai",
        // The sandbox's connect token, spent as a bearer — the platform resolves it to the account whose
        // allowance this turn costs. It is the same credential the daemon already presents to /sandbox/announce,
        // so the trial adds no new secret to this container.
        apiKey: config.connectToken,
    },
});

/* Lay the trial over a capabilities store. Reads see it; writes cannot touch it.
 *
 * `upsert` and `remove` pass straight through for every other id and refuse this one, rather than silently
 * writing a shadowing row — a persisted `free-trial` entry would outlive the platform's answer and become
 * exactly the stale, editable card this module exists to avoid. `remove` answers false, which is what every
 * other absent id answers, so the route above it needs no special case. */
export const withTrialEndpoint = (store: CapabilitiesStore, config: Config, trial: TrialService): CapabilitiesStore => ({
    list: async () => {
        const entries = await store.list();
        // A real entry with the reserved id wins — it can only exist if someone hand-edited the manifest, and
        // silently overriding what is on disk is how a file stops explaining the system it describes.
        if (!trial.available() || entries.some((entry) => entry.id === TRIAL_ENDPOINT_ID)) {
            return entries;
        }
        return [...entries, trialCapability(config)];
    },
    get: async (id) => {
        const existing = await store.get(id);
        if (existing !== undefined || id !== TRIAL_ENDPOINT_ID || !trial.available()) {
            return existing;
        }
        return trialCapability(config);
    },
    upsert: async (capability) => {
        if (capability.id === TRIAL_ENDPOINT_ID) {
            throw new Error(`"${TRIAL_ENDPOINT_ID}" is provisioned by intentic and cannot be edited`);
        }
        await store.upsert(capability);
    },
    remove: async (id) => (id === TRIAL_ENDPOINT_ID ? false : store.remove(id)),
});
