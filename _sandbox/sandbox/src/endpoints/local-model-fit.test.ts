import { LOCAL_MODELS } from "@intentic/sandbox-contract";
import { estimatedModelMemory, fitsBudget, freeMemoryFrom, fullSpeedFrom, localModelOffers, memoryFrom, runsAtFullSpeed } from "./local-model-fit.js";

// The arithmetic the connect view's offer and the start's admission check share. Reading the machine is the
// integration half's job (local-model-fit.integration.test.ts); nothing here touches a disk.

const GIB = 1024 ** 3;

test("the estimate is weights plus a q8 KV cache plus the runtime's own floor", () => {
    // 32k of cache is exactly 2 GiB at the contract's rate, and the floor is a flat GiB on top.
    expect(estimatedModelMemory(16_000_000_000, 32_768)).toBe(16_000_000_000 + 2 * 1024 ** 3 + 1024 ** 3);
    // Three times the window is three times the cache and nothing else: the floor is not paid twice.
    expect(estimatedModelMemory(16_000_000_000, 98_304) - estimatedModelMemory(16_000_000_000, 32_768)).toBe(4 * 1024 ** 3);
});

// A 16 GiB cap binds on the WSL guest's 19.53 GiB engine; a 32 GiB one never can, so the engine is the number then.
test("memory is the cap where it binds and the engine's total where it does not", () => {
    const meminfo = "MemTotal:       20479632 kB\nMemFree:          812344 kB\n";
    expect(memoryFrom("17179869184\n", meminfo)).toEqual({ bytes: 17_179_869_184, capped: true });
    expect(memoryFrom("34359738368\n", meminfo)).toEqual({ bytes: 20_479_632 * 1024, capped: false });
    expect(memoryFrom("max\n", meminfo)).toEqual({ bytes: 20_479_632 * 1024, capped: false });
    // An unreadable engine leaves the cap as the only number there is.
    expect(memoryFrom("17179869184\n", "")).toEqual({ bytes: 17_179_869_184, capped: true });
});

// Zero is "we could not measure", and refusing on a reading we never took would be worse than letting llama.cpp decide.
test("an unmeasurable budget admits everything, a measured one refuses what will not fit", () => {
    expect(fitsBudget(0, 500_000_000_000, 131_072)).toBe(true);
    expect(fitsBudget(8_000_000_000, 16_000_000_000, 16_384)).toBe(false);
    expect(fitsBudget(8_000_000_000, 1_000_000_000, 16_384)).toBe(true);
});

// Free, not total: a 16 GiB cap with 10 GiB of it in real use leaves 6, whatever the page cache adds to the usage figure.
test("free memory is the kernel's available figure, and inside a cap the cap's headroom net of reclaimable cache", () => {
    const meminfo = "MemTotal:       20479632 kB\nMemAvailable:    8388608 kB\n";
    expect(freeMemoryFrom({ cgroupMax: "max\n", cgroupCurrent: "", cgroupStat: "", meminfo })).toBe(8 * GIB);
    // 12 GiB charged, 2 GiB of it inactive page cache: 10 GiB in use, 6 GiB of the cap free, under the 8 available.
    const capped = { cgroupMax: `${16 * GIB}\n`, cgroupCurrent: `${12 * GIB}\n`, cgroupStat: `anon 1\ninactive_file ${2 * GIB}\n`, meminfo };
    expect(freeMemoryFrom(capped)).toBe(6 * GIB);
    // The machine can be the tighter one even inside a cap.
    expect(freeMemoryFrom({ ...capped, cgroupCurrent: `${2 * GIB}\n` })).toBe(8 * GIB);
    // Nothing readable is unmeasured, never "none free".
    expect(freeMemoryFrom({ cgroupMax: "max", cgroupCurrent: "", cgroupStat: "", meminfo: "" })).toBeUndefined();
});

test("full speed is the free memory's share, plus what this sandbox's own model holds; unreadable is unmeasured", () => {
    expect(fullSpeedFrom({ hostFreeBytes: 28 * GIB, heldBytes: 0 })).toEqual({ bytes: Math.round(28 * GIB * 0.8) });
    // A start stops every other local model and restarts its own, so what they hold is free to the model being sized;
    // without it the model already serving would read as not fitting on the machine it runs on.
    expect(fullSpeedFrom({ hostFreeBytes: 4 * GIB, heldBytes: 2 * GIB })).toEqual({ bytes: Math.round(6 * GIB * 0.8) });
    expect(fullSpeedFrom({ hostFreeBytes: undefined, heldBytes: 2 * GIB })).toBeUndefined();
});

test("zero free memory is a measurement that runs nothing at full speed, not an unmeasured one", () => {
    expect(runsAtFullSpeed({ bytes: 0 }, 1_000_000_000, 16_384)).toBe(false);
    expect(runsAtFullSpeed({ bytes: 6 * GIB }, 1_000_000_000, 16_384)).toBe(true);
});

// Offers are sized on free memory, starts on the total: a 32 GB container with 8 GB free recommends what fits in those
// 8, while the heaviest model, which fits the total, may still be started by hand.
test("a container with little free memory recommends what fits it, while a heavier model may still be started", () => {
    const budgetBytes = Math.round(40 * GIB * 0.8);
    const heaviest = LOCAL_MODELS.at(-1)!;
    expect(localModelOffers(budgetBytes, undefined).best).toEqual({ model: heaviest.id, context: "65536" });
    const tight = fullSpeedFrom({ hostFreeBytes: 8.125 * GIB, heldBytes: 0 });
    expect(localModelOffers(budgetBytes, tight)).toEqual({
        instant: { model: "unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf", context: "65536" },
        best: { model: "unsloth/Phi-4-mini-instruct-GGUF/Phi-4-mini-instruct-Q4_K_M.gguf", context: "32768" },
    });
    expect(fitsBudget(budgetBytes, heaviest.weightsBytes, 65_536)).toBe(true);
});

test("nothing runs at full speed in no free memory, so neither offer is made", () => {
    expect(localModelOffers(32 * GIB, { bytes: 0 })).toEqual({});
});
