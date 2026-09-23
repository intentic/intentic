import { estimatedModelMemory, fitsBudget, localModelGpu, memoryFrom } from "./local-model-fit.js";

// The arithmetic the connect view's offer and the start's admission check share. Reading the machine is the
// integration half's job (local-model-fit.integration.test.ts); nothing here touches a disk.

const gpuBefore = process.env["SANDBOX_GPU"];
afterEach(() => {
    if (gpuBefore === undefined) {
        delete process.env["SANDBOX_GPU"];
    } else {
        process.env["SANDBOX_GPU"] = gpuBefore;
    }
});

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

// The three states are a measurement, not a preference: `absent` still merits offering the switch, `unsupported` does
// not, and only `granted` may report VRAM.
test("the GPU state reads the runner's stamp, with absent distinct from unsupported", () => {
    delete process.env["SANDBOX_GPU"];
    expect(localModelGpu()).toBe("absent");
    process.env["SANDBOX_GPU"] = "unsupported";
    expect(localModelGpu()).toBe("unsupported");
    process.env["SANDBOX_GPU"] = "all";
    expect(localModelGpu()).toBe("granted");
});
