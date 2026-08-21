import { type Capability, TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { CompatEntry } from "../endpoints/endpoint-translator.js";
import type { Config } from "../env.config.js";
import type { PlatformTunnel } from "../platform/local-tunnel.js";
import type { TrialService } from "./trial.js";

/* THE TRIAL AS A CAPABILITY THE USER NEVER ADDED, provisioned by the daemon, and deliberately never written to
 * the manifest.
 *
 * It is a synthetic entry laid over the store rather than a row in .intentic/config/capabilities.json, and that is the
 * whole design. A persisted entry would be the user's to edit and delete, which is wrong in both directions: its
 * "API key" is this sandbox's connect token, so an editable card is a card that shows a credential and lets a
 * typo break the sandbox's identity to the platform; and a deleted entry would come back on the next boot,
 * which is a card that ignores the user. Neither is a thing a person should have to reason about for a trial
 * they will stop using the moment they connect an account.
 *
 * Synthetic also makes the lifecycle free. The trial exists exactly while the platform says it does, the
 * probe's answer IS the entry's existence, so a platform that turns the trial off, or an allowance that is
 * spent, needs no cleanup pass over a file. */

/* The entry the rest of the daemon sees. `openai` protocol, so it rides the translator's openai-compatibility
 * list like any other user-configured endpoint, which is what buys the trial the whole existing turn path.
 *
 * THE BASE URL IS THE TUNNEL'S WHERE THERE IS ONE, and that is not a detail of this card, it is what makes the
 * trial work at all against a platform on the developer's own machine. The consumer of this URL that matters is
 * the bundled translator, which is a Go binary that verifies certificates and cannot be told not to, so a
 * self-signed dev platform failed every turn on it (platform/local-tunnel.ts has the whole account). A deployed
 * platform opens no tunnel and this reads exactly as it always did. */
const trialBaseUrl = (config: Config, tunnel: PlatformTunnel): string => new URL("/trial/v1", tunnel.url() ?? config.platform.url).toString();

const trialCapability = (config: Config, tunnel: PlatformTunnel): Capability => ({
    id: TRIAL_ENDPOINT_ID,
    kind: "endpoint",
    config: {
        baseUrl: trialBaseUrl(config, tunnel),
        protocol: "openai",
        // The sandbox's connect token, spent as a bearer, the platform resolves it to the account whose
        // allowance this turn costs. It is the same credential the daemon already presents to /sandbox/announce,
        // so the trial adds no new secret to this container.
        apiKey: config.connectToken,
    },
});

/* THE TRIAL'S ROUTING ENTRY, and the deliberate asymmetry against the capability above: the capability exists
 * while the platform SAYS the trial does (probed, cached, offered), the routing entry exists whenever the
 * sandbox is CONFIGURED to have a platform at all.
 *
 * The two used to be one, and that one dependency is the bug this split removes. The translator writes its
 * routing table when it spawns, and the availability probe is an HTTPS round trip fired beside it, so on a
 * fresh install the table was written before the probe answered and the trial was offered but not routable:
 * every first message died with "unknown provider for model free-trial/auto" until an unrelated event (a
 * capability edit, a proxy crash) happened to rewrite the table. Rendering the entry from probe state made the
 * routing table a function of TIMING; rendering it from configuration makes it a constant, and a constant
 * cannot race, drift, or need re-syncing.
 *
 * Everything in the entry is known at boot: the platform's address (or the dev tunnel's, see trialCapability),
 * the connect token, and the one synthetic model id the trial publishes (TRIAL_MODEL_ID: the platform picks
 * the real model per message). Nothing is discovered, so unlike every user-added endpoint no catalog is
 * fetched to build it.
 *
 * A sandbox whose platform serves no trial carries the entry anyway, and that is harmless by construction:
 * nothing routes to it, because every surface that OFFERS the trial still reads the probe. If something is
 * sent regardless, the platform answers its own 404, which is the honest refusal from the party that owns the
 * decision. `undefined` only for a sandbox with no platform or no token: a loopback or test daemon, where
 * there is nothing to point the entry at. */
export const trialCompatEntry = (config: Config, tunnel: PlatformTunnel): CompatEntry | undefined => {
    if (config.platform.url === "" || config.connectToken === "") {
        return undefined;
    }
    return {
        name: TRIAL_ENDPOINT_ID,
        prefix: TRIAL_ENDPOINT_ID,
        "base-url": trialBaseUrl(config, tunnel),
        headers: {},
        "api-key-entries": [{ "api-key": config.connectToken }],
        models: [{ name: TRIAL_MODEL_ID, alias: TRIAL_MODEL_ID }],
    };
};

/* Lay the trial over a capabilities store. Reads see it; writes cannot touch it.
 *
 * `upsert` and `remove` pass straight through for every other id and refuse this one, rather than silently
 * writing a shadowing row, a persisted `free-trial` entry would outlive the platform's answer and become
 * exactly the stale, editable card this module exists to avoid. `remove` answers false, which is what every
 * other absent id answers, so the route above it needs no special case. */
export const withTrialEndpoint = (store: CapabilitiesStore, config: Config, trial: TrialService, tunnel: PlatformTunnel): CapabilitiesStore => ({
    list: async () => {
        const entries = await store.list();
        // A real entry with the reserved id wins, it can only exist if someone hand-edited the manifest, and
        // silently overriding what is on disk is how a file stops explaining the system it describes.
        if (!trial.available() || entries.some((entry) => entry.id === TRIAL_ENDPOINT_ID)) {
            return entries;
        }
        return [...entries, trialCapability(config, tunnel)];
    },
    get: async (id) => {
        const existing = await store.get(id);
        if (existing !== undefined || id !== TRIAL_ENDPOINT_ID || !trial.available()) {
            return existing;
        }
        return trialCapability(config, tunnel);
    },
    upsert: async (capability) => {
        if (capability.id === TRIAL_ENDPOINT_ID) {
            throw new Error(`"${TRIAL_ENDPOINT_ID}" is provisioned by intentic and cannot be edited`);
        }
        await store.upsert(capability);
    },
    remove: async (id) => (id === TRIAL_ENDPOINT_ID ? false : store.remove(id)),
});
