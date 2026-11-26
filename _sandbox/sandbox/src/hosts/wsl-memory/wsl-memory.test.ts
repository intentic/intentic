import type { Need, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { WslMemory, WslMemoryFit } from "@intentic/sandbox-contract/schemas/wsl-memory";
import { raiseWslMemoryCard, type WslMemoryCheckDeps, WSL_MEMORY_DECLINE_QUIET_MS, wslMemoryCardSuppressed, wslMemoryTitle, wslMemoryWorse } from "./wsl-memory.js";

// A WSL VM too big for its PC (2026-11-26): rog gives its VM 22 GB of 31.4 GiB and Windows sat under its low line for
// hours. The PC's agent proposes 15 GB in its facts; the sandbox raises one card, the next time a person speaks.

const GIB = 1024 ** 3;
const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2026, 10, 26, 14, 0);

const FIT: WslMemoryFit = {
    at: NOW,
    windowMs: 4 * 3_600_000,
    readings: 48,
    totalBytes: 31.4 * GIB,
    lowLineBytes: 3.14 * GIB,
    underLowShare: 0.875,
    availableMedianBytes: 2.6 * GIB,
    vmMedianBytes: 16.2 * GIB,
    outsideBytes: 12.5 * GIB,
    configuredGb: 22,
    proposedGb: 15,
    atFloor: false,
    text: "Windows had less than its 3.1 GiB low line available in 88% of the readings…",
};

const cardOf = (overrides: Partial<Need> & { readonly fit?: WslMemoryFit; readonly device?: string } = {}): Need => {
    const { fit = FIT, device = "rog", ...need } = overrides;
    return {
        id: "need-1",
        conversationId: "conv-a",
        subject: { kind: "wsl-memory", device, configPath: "C:\\Users\\radar\\.wslconfig", fit },
        title: "rog's WSL VM is too big for it: memory=15GB would fit",
        status: "open",
        createdAt: NOW - DAY,
        updatedAt: NOW - DAY,
        ...need,
    };
};

describe("wslMemoryCardSuppressed", () => {
    it("raises one when no card for that PC exists", () => {
        expect(wslMemoryCardSuppressed([], "rog", FIT, NOW)).toBeUndefined();
        expect(wslMemoryCardSuppressed([cardOf({ device: "omen" })], "rog", FIT, NOW)).toBeUndefined();
    });

    it("finds an open card for that PC in any conversation", () => {
        expect(wslMemoryCardSuppressed([cardOf({ conversationId: "conv-b" })], "rog", FIT, NOW)).toBe("need-1 is already open for it, in conversation conv-b");
    });

    it("keeps a declined card down for 30 days unless the PC got worse", () => {
        const declined = cardOf({ status: "declined", updatedAt: NOW - 10 * DAY });
        expect(wslMemoryCardSuppressed([declined], "rog", FIT, NOW)).toBe("a person declined need-1 within 30 days, and the PC is no worse since");
        // A smaller size fits now: worse.
        expect(wslMemoryCardSuppressed([declined], "rog", { ...FIT, proposedGb: 13 }, NOW)).toBeUndefined();
        // After 30 days it is asked again whatever it is.
        expect(wslMemoryCardSuppressed([cardOf({ status: "declined", updatedAt: NOW - WSL_MEMORY_DECLINE_QUIET_MS })], "rog", FIT, NOW)).toBeUndefined();
    });

    it("does not count a met card: the PC is too big again after a yes", () => {
        expect(wslMemoryCardSuppressed([cardOf({ status: "met" })], "rog", FIT, NOW)).toBeUndefined();
    });
});

describe("wslMemoryWorse", () => {
    it("is a smaller size, or Windows short in at least 15 points more of the readings", () => {
        expect(wslMemoryWorse(FIT, FIT)).toBe(false);
        expect(wslMemoryWorse(FIT, { ...FIT, proposedGb: 14 })).toBe(true);
        expect(wslMemoryWorse({ ...FIT, underLowShare: 0.7 }, { ...FIT, underLowShare: 0.8 })).toBe(false);
        expect(wslMemoryWorse({ ...FIT, underLowShare: 0.7 }, { ...FIT, underLowShare: 0.85 })).toBe(true);
        // A bigger size fits now: better, never a reason to ask again.
        expect(wslMemoryWorse(FIT, { ...FIT, proposedGb: 16 })).toBe(false);
    });
});

interface Harness {
    readonly deps: WslMemoryCheckDeps;
    readonly raised: { conversationId: string; subject: NeedSubject; title: string }[];
    readonly state: { door: { device: string; name: string } | undefined; memory: WslMemory | undefined; needs: Need[] };
}

const harness = (): Harness => {
    const raised: Harness["raised"] = [];
    const state: Harness["state"] = {
        door: { device: "rog", name: "rog" },
        memory: { configPath: "C:\\Users\\radar\\.wslconfig", configuredGb: 22, fit: FIT },
        needs: [],
    };
    const deps: WslMemoryCheckDeps = {
        now: () => NOW,
        selfHost: async () => state.door,
        memory: () => state.memory,
        needs: {
            list: async () => state.needs,
            observe: async (conversationId, subject, title) => {
                raised.push({ conversationId, subject, title });
                const need = cardOf({ conversationId, title });
                state.needs.push(need);
                return need;
            },
        },
        logger: { info: () => undefined },
    };
    return { deps, raised, state };
};

describe("raiseWslMemoryCard", () => {
    it("raises the card in the conversation a person spoke in, with what was measured and the file it writes", async () => {
        const { deps, raised } = harness();
        expect((await raiseWslMemoryCard(deps, "conv-a"))?.id).toBe("need-1");
        expect(raised).toEqual([
            { conversationId: "conv-a", subject: { kind: "wsl-memory", device: "rog", configPath: "C:\\Users\\radar\\.wslconfig", fit: FIT }, title: wslMemoryTitle("rog", FIT) },
        ]);
        expect(raised[0]?.title).toBe("rog's WSL VM is too big for it: memory=15GB would fit");
        // Said once: the next person's turn finds it open.
        expect(await raiseWslMemoryCard(deps, "conv-b")).toBeUndefined();
        expect(raised).toHaveLength(1);
    });

    it("raises nothing off a PC, without a finding, or from an agent older than the field", async () => {
        const { deps, raised, state } = harness();
        state.door = undefined;
        expect(await raiseWslMemoryCard(deps, "conv-a")).toBeUndefined();
        state.door = { device: "rog", name: "rog" };
        state.memory = { configPath: "C:\\Users\\radar\\.wslconfig", configuredGb: 15 };
        expect(await raiseWslMemoryCard(deps, "conv-a")).toBeUndefined();
        state.memory = undefined;
        expect(await raiseWslMemoryCard(deps, "conv-a")).toBeUndefined();
        expect(raised).toEqual([]);
    });
});
