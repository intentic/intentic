import type { Capability } from "@intentic/sandbox-contract";
import { TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Config } from "../env.config.js";
import type { PlatformTunnel } from "../platform/local-tunnel.js";
import { trialCompatEntry, withTrialEndpoint } from "./trial-endpoint.js";
import type { TrialService } from "./trial.js";

/* The trial is a capability nobody added, and the two things worth pinning are the two halves of that: reads
 * must SEE it (or the picker has no trial to offer), and writes must never persist it (or the file on disk
 * grows an entry holding this sandbox's connect token, editable by anyone with the capabilities UI open). */

const config = { platform: { url: `https://platform.test/` }, connectToken: `tok` } as Config;

const trialService = (available: boolean): TrialService => ({
    available: () => available,
    status: () => undefined,
    refresh: async () => undefined,
});

// A deployed platform opens none; the dev case is its own test below.
const noTunnel: PlatformTunnel = { url: () => undefined, ready: Promise.resolve(), close: () => undefined };

const memoryStore = (seed: Capability[] = []): CapabilitiesStore => {
    let entries = [...seed];
    return {
        list: async () => entries,
        get: async (id) => entries.find((entry) => entry.id === id),
        upsert: async (capability) => {
            entries = [...entries.filter((entry) => entry.id !== capability.id), capability];
        },
        remove: async (id) => {
            const next = entries.filter((entry) => entry.id !== id);
            const removed = next.length !== entries.length;
            entries = next;
            return removed;
        },
    };
};

const ollama: Capability = { id: `ollama`, kind: `endpoint`, config: { baseUrl: `http://host.docker.internal:11434/v1`, protocol: `openai` } };

describe("the free-trial endpoint", () => {
    it("appears in reads when the platform serves one, pointed at the platform with the connect token", async () => {
        const store = withTrialEndpoint(memoryStore([ollama]), config, trialService(true), noTunnel);

        const entries = await store.list();
        const trial = entries.find((entry) => entry.id === TRIAL_ENDPOINT_ID);

        expect(entries).toHaveLength(2);
        expect(trial?.kind).toBe(`endpoint`);
        // openai protocol, so it rides the translator's compat list like any user-configured endpoint, which is
        // what buys the trial the whole existing turn path.
        expect(trial?.config).toMatchObject({ baseUrl: `https://platform.test/trial/v1`, protocol: `openai`, apiKey: `tok` });
        expect(await store.get(TRIAL_ENDPOINT_ID)).toEqual(expect.any(Object));
    });

    /* THE TRANSLATOR IS THE CONSUMER OF THIS URL, and it is a Go binary that verifies certificates. A platform on
     * the developer's own machine serves a self-signed one for `localhost`, so every trial turn died inside
     * CLIProxyAPI as a 500 and reached the reader as "The model provider is not responding". The daemon
     * terminates that TLS itself (platform/local-tunnel.ts) and the card points at the loopback end of it. */
    it("points at the local tunnel when one is open, so the translator never has to verify a dev certificate", async () => {
        const tunnel: PlatformTunnel = { url: () => `http://127.0.0.1:41234`, ready: Promise.resolve(), close: () => undefined };
        const store = withTrialEndpoint(
            memoryStore(),
            { ...config, platform: { url: `https://host.docker.internal:6480` } } as Config,
            trialService(true),
            tunnel,
        );

        const trial = await store.get(TRIAL_ENDPOINT_ID);

        expect(trial?.config).toMatchObject({ baseUrl: `http://127.0.0.1:41234/trial/v1`, protocol: `openai`, apiKey: `tok` });
    });

    it("is absent when the platform serves none: the ordinary case", async () => {
        const store = withTrialEndpoint(memoryStore([ollama]), config, trialService(false), noTunnel);

        expect(await store.list()).toEqual([ollama]);
        expect(await store.get(TRIAL_ENDPOINT_ID)).toBeUndefined();
    });

    it("is never written to the manifest, and never removed from it", async () => {
        const file = memoryStore();
        const store = withTrialEndpoint(file, config, trialService(true), noTunnel);

        await expect(
            store.upsert({ id: TRIAL_ENDPOINT_ID, kind: `endpoint`, config: { baseUrl: `http://evil.test/v1`, protocol: `openai` } }),
        ).rejects.toThrow(/cannot be edited/);
        // A remove answers like any absent id rather than throwing, so the capabilities route above needs no
        // special case, and the underlying file is untouched either way.
        expect(await store.remove(TRIAL_ENDPOINT_ID)).toBe(false);
        expect(await file.list()).toEqual([]);
    });

    it("yields to a real entry that already holds the reserved id", async () => {
        // Only reachable by hand-editing the manifest. Silently overriding what is on disk is how a file stops
        // explaining the system it describes, so the file wins and the synthetic entry stands down.
        const planted: Capability = { id: TRIAL_ENDPOINT_ID, kind: `endpoint`, config: { baseUrl: `http://mine.test/v1`, protocol: `openai` } };
        const store = withTrialEndpoint(memoryStore([planted]), config, trialService(true), noTunnel);

        expect(await store.list()).toEqual([planted]);
        expect(await store.get(TRIAL_ENDPOINT_ID)).toEqual(planted);
    });

    it("passes every other capability straight through, reads and writes alike", async () => {
        const file = memoryStore();
        const store = withTrialEndpoint(file, config, trialService(true), noTunnel);

        await store.upsert(ollama);

        expect(await file.list()).toEqual([ollama]);
        expect(await store.remove(`ollama`)).toBe(true);
    });
});

/* The routing entry is the OTHER half of the trial, and the property worth pinning is its independence: it
 * takes no TrialService at all, so it CANNOT be built from probe state. That is the fresh-install fix: the
 * translator writes its routing table when it spawns, before the availability probe has answered, and an entry
 * derived from the probe was therefore missing exactly on the boot that mattered, refusing every first message
 * with "unknown provider for model free-trial/auto" until an unrelated rewrite healed it. */
describe("the free-trial routing entry", () => {
    it("is a constant of configuration: platform address, connect token, the one synthetic model", () => {
        const entry = trialCompatEntry(config, noTunnel);

        expect(entry).toEqual({
            name: TRIAL_ENDPOINT_ID,
            prefix: TRIAL_ENDPOINT_ID,
            "base-url": `https://platform.test/trial/v1`,
            headers: {},
            "api-key-entries": [{ "api-key": `tok` }],
            models: [{ name: TRIAL_MODEL_ID, alias: TRIAL_MODEL_ID }],
        });
    });

    it("points at the local tunnel when one is open, the same address the capability card carries", () => {
        const tunnel: PlatformTunnel = { url: () => `http://127.0.0.1:41234`, ready: Promise.resolve(), close: () => undefined };

        expect(trialCompatEntry(config, tunnel)?.["base-url"]).toBe(`http://127.0.0.1:41234/trial/v1`);
    });

    it("is absent only where there is nothing to point it at: no platform, or no token", () => {
        expect(trialCompatEntry({ platform: { url: `` }, connectToken: `tok` } as Config, noTunnel)).toBeUndefined();
        expect(trialCompatEntry({ platform: { url: `https://platform.test/` }, connectToken: `` } as Config, noTunnel)).toBeUndefined();
    });
});
