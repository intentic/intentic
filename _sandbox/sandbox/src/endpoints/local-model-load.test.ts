import { offloadShortfall, parseLoadLog } from "./local-model-load.js";

// What a load's log says about where its layers went, in the pinned llama.cpp build's own spelling (b11146:
// src/llama-model.cpp, llama-kv-cache.cpp, llama-context.cpp). Reading the machine's processes is not this file's job.

const MIB = 1024 ** 2;

const LOADED_WHOLE = [
    "load_tensors: loading model tensors, this can take a while... (mmap = true)",
    "load_tensors: offloading output layer to GPU",
    "load_tensors: offloading 32 repeating layers to GPU",
    "load_tensors: offloaded 33/33 layers to GPU",
    "load_tensors:        CUDA0 model buffer size =  4403.50 MiB",
    "load_tensors:   CPU_Mapped model buffer size =   292.36 MiB",
    "llama_kv_cache:      CUDA0 KV buffer size =   576.00 MiB",
    "llama_context:      CUDA0 compute buffer size =   300.50 MiB",
    "llama_context:  CUDA_Host compute buffer size =    72.01 MiB",
    "srv  log_server_r: request: GET /health 127.0.0.1 200",
].join("\n");

test("a whole load reads as every layer on the GPU, and what it holds there counts the card's buffers only", () => {
    expect(parseLoadLog(LOADED_WHOLE)).toEqual({ offloaded: { layers: 33, of: 33 }, gpuBytes: (4403.5 + 576 + 300.5) * MIB });
    expect(offloadShortfall(parseLoadLog(LOADED_WHOLE))).toBeUndefined();
});

test("a split load names how many layers reached the card", () => {
    const split = parseLoadLog("load_tensors: offloaded 20/49 layers to GPU\nload_tensors:        CUDA0 model buffer size =  6000.00 MiB\n");
    expect(split).toEqual({ offloaded: { layers: 20, of: 49 }, gpuBytes: 6000 * MIB });
    expect(offloadShortfall(split)).toEqual({
        code: "gpu-partial",
        detail: "only 20 of 49 layers fit on the GPU, the rest run on the CPU and set its pace",
    });
});

// The line is printed only by a build that can offload, so its absence is the CPU build or a card the build never saw.
test("a load with no offload line, or with none offloaded, runs on the CPU", () => {
    const cpu = parseLoadLog("load_tensors:          CPU model buffer size =  4403.50 MiB\n");
    expect(cpu).toEqual({ gpuBytes: 0 });
    expect(offloadShortfall(cpu)).toEqual({ code: "gpu-unused", detail: "running on the CPU: llama-server found no GPU to offload to" });
    expect(offloadShortfall(parseLoadLog("load_tensors: offloaded 0/33 layers to GPU\n"))).toEqual({
        code: "gpu-unused",
        detail: "running on the CPU: none of its 33 layers fit on the GPU",
    });
});

// `--fit` measures before it loads; should a measurement ever print, the last load is the one running.
test("only the last load counts, and only the buffers printed after it", () => {
    const measured = "load_tensors: offloaded 33/33 layers to GPU\nload_tensors:        CUDA0 model buffer size =  9000.00 MiB\n";
    expect(parseLoadLog(`${measured}${LOADED_WHOLE}`)).toEqual(parseLoadLog(LOADED_WHOLE));
});

// An unread log is not evidence of a CPU run; the row says nothing rather than guess.
test("no report says nothing", () => {
    expect(offloadShortfall(undefined)).toBeUndefined();
});
