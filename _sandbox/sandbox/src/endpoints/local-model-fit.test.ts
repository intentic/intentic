import { afterEach, expect, test } from "vitest";
import { estimatedModelMemory, fitsBudget, localModelGpu } from "./local-model-fit.js";

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
