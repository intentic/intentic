import type { Capability } from "@intentic/sandbox-contract";
import { TRIAL_ENDPOINT_ID } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Config } from "../env.config.js";
import { withTrialEndpoint } from "./trial-endpoint.js";
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
        const store = withTrialEndpoint(memoryStore([ollama]), config, trialService(true));

        const entries = await store.list();
        const trial = entries.find((entry) => entry.id === TRIAL_ENDPOINT_ID);

        expect(entries).toHaveLength(2);
        expect(trial?.kind).toBe(`endpoint`);
        // openai protocol, so it rides the translator's compat list like any user-configured endpoint — which is
        // what buys the trial the whole existing turn path.
        expect(trial?.config).toMatchObject({ baseUrl: `https://platform.test/trial/v1`, protocol: `openai`, apiKey: `tok` });
        expect(await store.get(TRIAL_ENDPOINT_ID)).toBeDefined();
    });

    it("is absent when the platform serves none — the ordinary case", async () => {
        const store = withTrialEndpoint(memoryStore([ollama]), config, trialService(false));

        expect(await store.list()).toEqual([ollama]);
        expect(await store.get(TRIAL_ENDPOINT_ID)).toBeUndefined();
    });

    it("is never written to the manifest, and never removed from it", async () => {
        const file = memoryStore();
        const store = withTrialEndpoint(file, config, trialService(true));

        await expect(
            store.upsert({ id: TRIAL_ENDPOINT_ID, kind: `endpoint`, config: { baseUrl: `http://evil.test/v1`, protocol: `openai` } }),
        ).rejects.toThrow(/cannot be edited/);
        // A remove answers like any absent id rather than throwing, so the capabilities route above needs no
        // special case — and the underlying file is untouched either way.
        expect(await store.remove(TRIAL_ENDPOINT_ID)).toBe(false);
        expect(await file.list()).toEqual([]);
    });

    it("yields to a real entry that already holds the reserved id", async () => {
        // Only reachable by hand-editing the manifest. Silently overriding what is on disk is how a file stops
        // explaining the system it describes, so the file wins and the synthetic entry stands down.
        const planted: Capability = { id: TRIAL_ENDPOINT_ID, kind: `endpoint`, config: { baseUrl: `http://mine.test/v1`, protocol: `openai` } };
        const store = withTrialEndpoint(memoryStore([planted]), config, trialService(true));

        expect(await store.list()).toEqual([planted]);
        expect(await store.get(TRIAL_ENDPOINT_ID)).toEqual(planted);
    });

    it("passes every other capability straight through, reads and writes alike", async () => {
        const file = memoryStore();
        const store = withTrialEndpoint(file, config, trialService(true));

        await store.upsert(ollama);

        expect(await file.list()).toEqual([ollama]);
        expect(await store.remove(`ollama`)).toBe(true);
    });
});
