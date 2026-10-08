import { judge, type MemoryReading } from "@intentic/constants/memory-room";
import { memoryReading } from "./heldQueue";
import { memoryShare, memoryTip } from "./memoryTip";

// The card is read out of the daemon's own sentence, so every case here asks the daemon's `judge` for that sentence
// rather than typing one: a change to its wording fails this file instead of emptying the hover.

const GIB = 1024 ** 3;

const reading = (over: Partial<MemoryReading>): MemoryReading => ({
    limitBytes: 18 * GIB,
    usedBytes: 17.6 * GIB,
    swapBytes: 0,
    stallPercent: 0,
    oomKills: 0,
    ...over,
});

// The row's first sentence, as the chat keeps it (memoryReading), from the diagnosis the daemon refused with.
const sentence = (over: Partial<MemoryReading>, reservedBytes = 0): string => {
    const { diagnosis } = judge(reading(over), { workload: `agentRuntime`, attended: true, reservedBytes });
    if (diagnosis === undefined) {
        throw new Error(`the reading was not short of memory`);
    }
    return memoryReading(`${diagnosis}. Starting another agent now can slow the running ones down.`);
};

const figures = (text: string): Record<string, string | number> =>
    Object.fromEntries((memoryTip(text)?.rows ?? []).map((row) => [row.label, row.value]));

it(`names resident, swapped, the limit and what other work holds, apart`, () => {
    const tip = memoryTip(sentence({ usedBytes: 11.5 * GIB, swapBytes: 4.1 * GIB, limitBytes: 12 * GIB }, 6 * GIB));
    expect(tip?.title).toBe(`Memory low`);
    expect(tip?.tone).toBe(`warning`);
    expect(Object.fromEntries((tip?.rows ?? []).map((row) => [row.label, row.value]))).toEqual({
        "In RAM": `7.4 GiB`,
        Swapped: `4.1 GiB`,
        Limit: `12.0 GiB`,
        Reserved: `6.0 GiB`,
    });
});

it(`names used against the limit when nothing is swapped`, () => {
    expect(figures(sentence({ usedBytes: 17.6 * GIB }))).toEqual({ Used: `17.6 GiB`, Limit: `18.0 GiB` });
});

it(`names what the machine has left when the machine is what ran out`, () => {
    expect(figures(sentence({ usedBytes: 8 * GIB, availableBytes: 0.5 * GIB }, 2 * GIB))).toEqual({ "Host free": `0.5 GiB`, Reserved: `2.0 GiB` });
});

it(`names the stall when memory pressure is what refused it`, () => {
    expect(figures(sentence({ usedBytes: 2 * GIB, stallPercent: 45 }))).toEqual({ Stalled: `45%` });
});

// The line it hangs off already says memory is low: a card that could only repeat it is no card.
it(`raises nothing for a sentence with no figures`, () => {
    expect(memoryTip(`Sandbox memory is low.`)).toBeUndefined();
    expect(memoryTip(undefined)).toBeUndefined();
});

// The notice over the composer says the hold in a few characters: in use against the limit, resident when swap is in play.
// Free is the limit less what is resident, so the swap case is short only once its resident part nears the limit.
it(`says in use against the limit in a few characters, and nothing where no ceiling is named`, () => {
    expect(memoryShare(sentence({ usedBytes: 9.7 * GIB, swapBytes: 2.4 * GIB, limitBytes: 8 * GIB }))).toBe(`7.3/8.0 GiB`);
    expect(memoryShare(sentence({ usedBytes: 17.6 * GIB }))).toBe(`17.6/18.0 GiB`);
    expect(memoryShare(sentence({ usedBytes: 2 * GIB, stallPercent: 45 }))).toBeUndefined();
    expect(memoryShare(undefined)).toBeUndefined();
});

// Once swap is full the swapped part counts against the limit, so the notice counts it too: "12.0/20.0 GiB" would read
// as a refusal with room to spare.
it(`counts the swapped part in use once the sentence says swap is full`, () => {
    const full = sentence({ limitBytes: 20 * GIB, usedBytes: 22 * GIB, swapBytes: 10 * GIB, swapLimitBytes: 10 * GIB });
    expect(full).toContain(`with swap full`);
    expect(memoryShare(full)).toBe(`22.0/20.0 GiB`);
    expect(figures(full)).toMatchObject({ [`In RAM`]: `12.0 GiB`, [`Swapped`]: `10.0 GiB` });
});
