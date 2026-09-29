import { LOCAL_MODELS } from "@intentic/sandbox-contract";
import {
    estimatedModelMemory,
    fitsBudget,
    freeMemoryFrom,
    fullSpeedFrom,
    gpuReadingFrom,
    localModelGpu,
    localModelOffers,
    memoryFrom,
    runsAtFullSpeed,
} from "./local-model-fit.js";

// The arithmetic the connect view's offer and the start's admission check share. Reading the machine is the
// integration half's job (local-model-fit.integration.test.ts); nothing here touches a disk.

const GIB = 1024 ** 3;
const NOTHING_HELD = { hostBytes: 0, gpuBytes: 0 };

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

test("nvidia-smi is read per card: the largest total and, separately, the most free", () => {
    expect(gpuReadingFrom("8192, 7000\n24576, 1024\n")).toEqual({ totalBytes: 24_576 * 1024 ** 2, freeBytes: 7000 * 1024 ** 2 });
    // An answer that is not one reads as no GPU memory, which already means "size against the host alone".
    expect(gpuReadingFrom("")).toEqual({ totalBytes: 0, freeBytes: 0 });
    expect(gpuReadingFrom("[N/A], [N/A]\nNVIDIA-SMI has failed\n")).toEqual({ totalBytes: 0, freeBytes: 0 });
});

test("full speed is one device: the GPU less the margin --fit keeps wherever one answered, the host's free share otherwise", () => {
    const granted = { gpu: "granted" as const, gpuMemoryBytes: 8 * GIB, gpuFreeBytes: 7.5 * GIB, hostFreeBytes: 28 * GIB, held: NOTHING_HELD };
    expect(fullSpeedFrom(granted)).toEqual({ device: "gpu", bytes: 6.5 * GIB });
    // The host's 28 GiB free is not added to the card: a split model runs at the CPU's pace.
    expect(fullSpeedFrom({ ...granted, gpu: "absent", gpuMemoryBytes: 0, gpuFreeBytes: 0 })).toEqual({ device: "host", bytes: Math.round(28 * GIB * 0.8) });
    // Granted but unreadable is no card to size against.
    expect(fullSpeedFrom({ ...granted, gpuMemoryBytes: 0, gpuFreeBytes: 0 })).toEqual({ device: "host", bytes: Math.round(28 * GIB * 0.8) });
    expect(fullSpeedFrom({ ...granted, gpu: "absent", hostFreeBytes: undefined })).toBeUndefined();
});

// A start stops every other local model and restarts its own, so what they hold is free to the model being sized;
// without it the model already serving would read as not fitting on the machine it runs on.
test("what this sandbox's own model holds counts as free, but never past the device's total", () => {
    const busy = { gpu: "granted" as const, gpuMemoryBytes: 8 * GIB, gpuFreeBytes: 1 * GIB, hostFreeBytes: 4 * GIB };
    expect(fullSpeedFrom({ ...busy, held: { hostBytes: 0, gpuBytes: 6 * GIB } })).toEqual({ device: "gpu", bytes: 6 * GIB });
    expect(fullSpeedFrom({ ...busy, gpuFreeBytes: 7.5 * GIB, held: { hostBytes: 0, gpuBytes: 6 * GIB } })).toEqual({ device: "gpu", bytes: 7 * GIB });
    expect(fullSpeedFrom({ ...busy, gpu: "absent", held: { hostBytes: 2 * GIB, gpuBytes: 0 } })).toEqual({ device: "host", bytes: Math.round(6 * GIB * 0.8) });
});

test("zero free memory is a measurement that runs nothing at full speed, not an unmeasured one", () => {
    expect(runsAtFullSpeed({ device: "host", bytes: 0 }, 1_000_000_000, 16_384)).toBe(false);
    expect(runsAtFullSpeed({ device: "gpu", bytes: 6 * GIB }, 1_000_000_000, 16_384)).toBe(true);
});

// The case that moved the recommendation off the sum: an 8 GB card in a 32 GB container. The sum admits the 27B, which
// would run mostly on the CPU; one device's free memory offers what the card holds whole.
test("an 8 GB card beside a 32 GB container recommends what the card holds, while the 27B may still be started", () => {
    const budgetBytes = Math.round((32 * GIB + 8 * GIB) * 0.8);
    const heaviest = LOCAL_MODELS.at(-1)!;
    expect(localModelOffers(budgetBytes, undefined).best).toEqual({ model: heaviest.id, context: "65536" });
    const card = fullSpeedFrom({ gpu: "granted", gpuMemoryBytes: 8 * GIB, gpuFreeBytes: 7.5 * GIB, hostFreeBytes: 28 * GIB, held: NOTHING_HELD });
    expect(localModelOffers(budgetBytes, card)).toEqual({
        instant: { model: "unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf", context: "65536" },
        best: { model: "unsloth/Phi-4-mini-instruct-GGUF/Phi-4-mini-instruct-Q4_K_M.gguf", context: "32768" },
    });
    // Refusing is for what cannot load at all: the 27B fits across card and memory, so a start on it is admitted.
    expect(fitsBudget(budgetBytes, heaviest.weightsBytes, 65_536)).toBe(true);
});

test("nothing runs at full speed in no free memory, so neither offer is made", () => {
    expect(localModelOffers(32 * GIB, { device: "host", bytes: 0 })).toEqual({});
});
