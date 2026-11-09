import { presentationDigest } from "@intentic/api-contract/ingress";
import { memoryPresentationStore } from "./presentation-store.testing.js";
import type { HeldPresentation } from "./presentation-store.js";
import type { PresentationAnswer } from "../platform-client.js";
import { createPresentationMirror } from "./presentation-mirror.js";

/* The sandbox keeps a copy of its name and logo so a client that reaches it while the platform is down still shows them.
 * Only the platform's own answer changes the copy; a platform that is down, refuses or says something unreadable leaves
 * it, and an announce whose digest matches the copy's asks nothing. */

const logo = "data:image/webp;base64,AA==";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const EARLIER = "2026-11-08T09:00:00.000Z";

// The platform as the mirror sees it: each ask takes the next answer off `answers` (undefined is no news: unreachable,
// a refusal, a body that is not one), and every ask is counted.
const platform = (...answers: (PresentationAnswer | undefined)[]) => {
    let asked = 0;
    return {
        ask: async (): Promise<PresentationAnswer | undefined> => {
            asked += 1;
            return answers.shift();
        },
        asked: () => asked,
    };
};

const logger = { warn: jest.fn() };

const mirrorOver = (held: HeldPresentation | undefined, ...answers: (PresentationAnswer | undefined)[]) => {
    const store = memoryPresentationStore(held);
    const fake = platform(...answers);
    const mirror = createPresentationMirror({ store, ask: fake.ask, logger, now: () => NOW });
    return { mirror, store, asked: fake.asked };
};

const heard = { name: "radarsu-intentic", image: logo, digest: "02b432befa9d920e3ee21b6ef5d0a5e6", at: EARLIER };

describe("an announce's digest", () => {
    it("asks nothing when it is the copy's", async () => {
        const { mirror, store, asked } = mirrorOver(heard);
        await mirror.announced("02b432befa9d920e3ee21b6ef5d0a5e6");
        expect(asked()).toBe(0);
        expect(await store.read()).toEqual(heard);
    });

    it("asks the platform when it differs, and keeps the answer with its digest and when it was heard", async () => {
        const { mirror, store, asked } = mirrorOver(heard, { name: "renamed", digest: "aaaa" });
        await mirror.announced("aaaa");
        expect(asked()).toBe(1);
        expect(await store.read()).toEqual({ name: "renamed", digest: "aaaa", at: NOW.toISOString() });
    });

    it("asks when nothing is held yet", async () => {
        const { mirror, store, asked } = mirrorOver(undefined, { name: "workspace", digest: "d2e9f563419699d12f7be092973f94a2" });
        await mirror.announced("d2e9f563419699d12f7be092973f94a2");
        expect(asked()).toBe(1);
        expect(await store.read()).toEqual({ name: "workspace", digest: "d2e9f563419699d12f7be092973f94a2", at: NOW.toISOString() });
    });

    it("keeps the copy when the platform cannot be reached or refuses", async () => {
        const { mirror, store, asked } = mirrorOver(heard, undefined);
        await mirror.announced("bbbb");
        expect(asked()).toBe(1);
        expect(await store.read()).toEqual(heard);
    });

    it("removes the copy on the platform's own answer that there is no name and no logo", async () => {
        const { mirror, store } = mirrorOver(heard, { name: "", image: "", digest: "cccc" });
        await mirror.announced("cccc");
        expect(await store.read()).toBeUndefined();
    });

    // An older platform's answer carries no digest; the copy's is computed by the platform's own rule, so the next
    // announce's digest matches it and asks nothing more.
    it("digests an answer that carries none by the platform's rule", async () => {
        const { mirror, store, asked } = mirrorOver(undefined, { name: "radarsu-intentic", image: logo });
        await mirror.announced("02b432befa9d920e3ee21b6ef5d0a5e6");
        expect(await store.read()).toEqual({ name: "radarsu-intentic", image: logo, digest: "02b432befa9d920e3ee21b6ef5d0a5e6", at: NOW.toISOString() });
        await mirror.announced("02b432befa9d920e3ee21b6ef5d0a5e6");
        expect(asked()).toBe(1);
    });

    it("shares one ask with a refresh that arrives meanwhile", async () => {
        const { mirror, asked } = mirrorOver(undefined, { name: "workspace", digest: "dddd" });
        const [, refreshed] = await Promise.all([mirror.announced("dddd"), mirror.refresh()]);
        expect(asked()).toBe(1);
        expect(refreshed).toEqual({ presentation: { name: "workspace", digest: "dddd", at: NOW.toISOString() }, refreshed: true });
    });
});

describe("a refresh", () => {
    it("answers the copy held, unrefreshed, when the platform cannot be reached", async () => {
        const { mirror } = mirrorOver(heard, undefined);
        expect(await mirror.refresh()).toEqual({ presentation: heard, refreshed: false });
    });

    it("answers no copy, unrefreshed, when none was ever heard and the platform is down", async () => {
        const { mirror } = mirrorOver(undefined, undefined);
        expect(await mirror.refresh()).toEqual({ presentation: undefined, refreshed: false });
    });

    it("keeps and answers what the platform says now", async () => {
        const { mirror, store } = mirrorOver(heard, { name: "radarsu-intentic", digest: "eeee" });
        const fresh = { name: "radarsu-intentic", digest: "eeee", at: NOW.toISOString() };
        expect(await mirror.refresh()).toEqual({ presentation: fresh, refreshed: true });
        expect(await store.read()).toEqual(fresh);
    });

    it("writes nothing when the platform says what is already held", async () => {
        const { mirror, store } = mirrorOver(heard, { name: heard.name, image: logo, digest: heard.digest });
        expect(await mirror.refresh()).toEqual({ presentation: heard, refreshed: true });
        expect(store.writes()).toBe(0);
    });
});

describe("an adoption the platform took", () => {
    it("keeps the name and logo it sent, digested so the announce after it asks nothing when the row took them", async () => {
        const { mirror, store, asked } = mirrorOver(undefined);
        await mirror.adopted({ name: "radarsu-intentic", image: logo });
        const digest = await presentationDigest("radarsu-intentic", logo);
        expect(await store.read()).toEqual({ name: "radarsu-intentic", image: logo, digest, at: NOW.toISOString() });
        await mirror.announced(digest);
        expect(asked()).toBe(0);
    });

    it("keeps nothing when it sent no name, leaving the announce after it to ask", async () => {
        const { mirror, store } = mirrorOver(heard);
        await mirror.adopted({ image: logo });
        await mirror.adopted({});
        expect(await store.read()).toEqual(heard);
    });
});

describe("an export's ask", () => {
    it("packs what the platform said, and keeps it", async () => {
        const { mirror, store } = mirrorOver(undefined, { name: "radarsu-intentic", image: logo, digest: "ffff" });
        expect(await mirror.forExport()).toEqual({ name: "radarsu-intentic", image: logo });
        expect(await store.read()).toEqual({ name: "radarsu-intentic", image: logo, digest: "ffff", at: NOW.toISOString() });
    });

    it("packs nothing and keeps the copy when the platform cannot be reached", async () => {
        const { mirror, store } = mirrorOver(heard, undefined);
        expect(await mirror.forExport()).toBeUndefined();
        expect(await store.read()).toEqual(heard);
    });
});
