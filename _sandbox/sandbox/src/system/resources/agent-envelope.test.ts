import { realYield } from "@intentic/testing/bun";
import { agentFootprints, createAgentEnvelope, envelopeOf, type FootprintRow, MEASURED_BEFORE_LEARNED, quantileOf } from "./agent-envelope.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const minute = (index: number): number => index * 60_000;
const measured = (mibs: readonly number[]) => mibs.map((mib) => ({ mib, at: 0 }));

// One child's minute as the scan saw it: its runtime, a script it ran outside the queue, a build the queue let in.
const childMinute = (owner: string, scriptMib: number): FootprintRow[] => [
    { owner, role: "agentRuntime", rssBytes: 200 * MIB, swapBytes: 0 },
    { owner, role: "other", rssBytes: scriptMib * MIB, swapBytes: 0 },
    { owner, role: "toolchain", queued: true, rssBytes: 4 * GIB, swapBytes: 0 },
];

test("an agent's footprint is what its conversation holds but what the queue covers, for conversations whose runtime runs here", () => {
    const rows: FootprintRow[] = [
        { owner: "sub-pond", role: "agentRuntime", rssBytes: 250 * MIB, swapBytes: 10 * MIB },
        { owner: "sub-pond", role: "other", rssBytes: 3 * GIB, swapBytes: 0 },
        { owner: "sub-pond", role: "toolchain", queued: true, rssBytes: 4 * GIB, swapBytes: 0 },
        // A compiler the queue never judged is the agent's own to answer for.
        { owner: "sub-pond", role: "toolchain", rssBytes: GIB, swapBytes: 0 },
        // On a runner: its commands' leftovers here are no agent turn of this sandbox's.
        { owner: "sub-omen", role: "other", rssBytes: GIB, swapBytes: 0 },
        { owner: "daemon", role: "agentRuntime", rssBytes: GIB, swapBytes: 0 },
        { role: "other", rssBytes: GIB, swapBytes: 0 },
    ];
    expect(agentFootprints(rows)).toEqual(new Map([["sub-pond", 4 * GIB + 260 * MIB]]));
});

test("the envelope is the class's price until enough agents were measured, then their heavier quarter's, within bounds", () => {
    expect(quantileOf([], 0.5)).toBeUndefined();
    expect(envelopeOf(measured([300, 400, 500]))).toEqual({ bytes: GIB, learnedFrom: 0 });
    // Most agents light, a few heavy: the lease is the heavier quarter's, not the median's.
    expect(envelopeOf(measured([300, 320, 350, 400, 450, 700, 900, 3000]))).toEqual({ bytes: 700 * MIB, learnedFrom: MEASURED_BEFORE_LEARNED });
    expect(envelopeOf(measured(Array.from({ length: 8 }, () => 100))).bytes).toBe(256 * MIB);
    expect(envelopeOf(measured(Array.from({ length: 8 }, () => 9000))).bytes).toBe(4 * GIB);
});

test("an agent is measured over the minutes its turn was live here, and is one of the measured once it has gone", async () => {
    const written: (readonly { mib: number; at: number }[])[] = [];
    const envelope = createAgentEnvelope({ read: async () => [], write: async (agents) => void written.push(agents) });
    const live = new Set(["sub-frog"]);
    for (let index = 0; index < 10; index += 1) {
        await envelope.observe(childMinute("sub-frog", index >= 8 ? 2_000 : 100), live, minute(index));
    }
    expect(envelope.footprints(live)).toEqual(new Map([["sub-frog", 2_200 * MIB]]));
    expect(envelope.footprints(new Set())).toEqual(new Map());
    // Its turn ended and its runtime idles on: not sampled, and not gone until GONE_MS has passed unseen.
    await envelope.observe(childMinute("sub-frog", 100), new Set(), minute(12));
    expect(written).toEqual([]);
    await envelope.observe([], new Set(), minute(15));
    expect(written).toEqual([[{ mib: 2_200, at: minute(15) }]]);
});

test("a turn too short to have grown teaches nothing, and the measured agents kept on disk count after a restart", async () => {
    const kept = measured(Array.from({ length: 8 }, () => 600));
    const writes: number[] = [];
    const envelope = createAgentEnvelope({ read: async () => kept, write: async (agents) => void writes.push(agents.length) });
    await realYield();
    expect(envelope.envelope()).toEqual({ bytes: 600 * MIB, learnedFrom: 8 });
    await envelope.observe(childMinute("sub-tea", 100), new Set(["sub-tea"]), minute(0));
    await envelope.observe(childMinute("sub-tea", 100), new Set(["sub-tea"]), minute(1));
    await envelope.observe([], new Set(), minute(10));
    expect(writes).toEqual([]);
});
