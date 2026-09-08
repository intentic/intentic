import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { LOCAL_MODEL_WINDOW_DEFAULT, type LocalModelConfig } from "@intentic/sandbox-contract";
import type { CapabilityCtx } from "../capability.js";

// Pins that apply returns while the download is still running, status reports progress meanwhile, and an interrupted
// download resumes from its part file instead of refetching.

// Must define `promisify.custom`, like the real execFile does; without it promisify falls back to the bare-callback
// convention and every `.stdout` read comes back undefined instead of throwing.
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const execFile = (_file: string, _args: readonly string[], done: (error: Error | null, stdout: string, stderr: string) => void): void => {
        done(null, "", "");
    };
    return { ...actual, execFile: Object.assign(execFile, { [promisify.custom]: async () => ({ stdout: "", stderr: "" }) }) };
});

const { localModelHandler } = await import("./localmodel.handler.js");

const MODEL_URL = "https://models.test/weights/tiny.gguf";
const CHUNK = 512 * 1024;
const WEIGHTS = Buffer.alloc(4 * CHUNK, 0x42);

const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "localmodel-"));
    await mkdir(join(root, ".intentic/local/cache/models"), { recursive: true });
    return root;
};

const modelPath = (root: string): string => join(root, ".intentic/local/cache/models/tiny.gguf");

interface Panels {
    readonly start: ReturnType<typeof vi.fn>;
    readonly stop: ReturnType<typeof vi.fn>;
}

interface Context {
    readonly ctx: CapabilityCtx;
    readonly panels: Panels;
    readonly syncEndpoints: ReturnType<typeof vi.fn>;
}

// `panelRunning` is what the serving watcher polls alongside /health; a test wanting it to keep looking must say the
// panel is up. Defaults to dead, so unrelated tests don't leave one running.
const context = (root: string, panelRunning = false): Context => {
    const panels: Panels = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const syncEndpoints = vi.fn(async () => undefined);
    const ctx = {
        workspace: { root },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        panels: { ...panels, running: () => panelRunning },
        capabilities: { list: async () => [] },
        endpointModels: { forget: async () => undefined },
        syncEndpoints,
    } as unknown as CapabilityCtx;
    return { ctx, panels, syncEndpoints };
};

// Health defaults to not-serving unless a test opts in; most of these tests are about the weights arriving, not the
// serving state.
const serve = (body: ReadableStream<Uint8Array>, headers: Record<string, string>, status: number): Response =>
    new Response(body, { status, headers });

const stubFetch = (onModel: (init: RequestInit | undefined) => Response, healthy = false): void => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(MODEL_URL)) {
            return onModel(init);
        }
        return new Response(null, { status: healthy && url.endsWith("/health") ? 200 : 503 });
    });
};

// Whole weights in a single chunk, what every non-resume test wants.
const wholeFile = (): Response =>
    serve(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(WEIGHTS);
                controller.close();
            },
        }),
        { "content-length": String(WEIGHTS.byteLength) },
        200,
    );

// Runs apply to the end of its stream. `rung`/`typed` are parameters because the window is a parameter of the card;
// download tests omit them for the default.
const drain = async (id: string, ctx: CapabilityCtx, rung: LocalModelConfig["context"] = LOCAL_MODEL_WINDOW_DEFAULT, typed?: number): Promise<void> => {
    const config: LocalModelConfig = {
        model: "custom",
        gpu: "off",
        url: MODEL_URL,
        context: rung,
        ...(typed === undefined ? {} : { contextTokens: typed }),
    };
    for await (const line of localModelHandler.apply(ctx, id, config)) {
        void line;
    }
};

const statusOf = (ctx: CapabilityCtx, id: string) =>
    localModelHandler.status(ctx, id, { model: "custom", gpu: "off", url: MODEL_URL, context: LOCAL_MODEL_WINDOW_DEFAULT });

test("apply returns while the weights are still arriving, and the card reports the progress", async () => {
    const root = await workspace();
    const { ctx, panels } = context(root);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    stubFetch(() =>
        serve(
            new ReadableStream<Uint8Array>({
                async start(controller) {
                    controller.enqueue(WEIGHTS.subarray(0, CHUNK));
                    await gate;
                    controller.enqueue(WEIGHTS.subarray(CHUNK));
                    controller.close();
                },
            }),
            { "content-length": String(WEIGHTS.byteLength) },
            200,
        ),
    );

    // The wedged stream never closes; reaching this line at all is the assertion.
    await drain("held-open", ctx);
    expect(existsSync(modelPath(root))).toBe(false);

    await vi.waitFor(async () => {
        const status = await statusOf(ctx, "held-open");
        expect(status.state).toBe("pending");
        expect(status.detail).toMatch(/downloading .* \/ .*GB/);
    }, SETTLES);

    release();
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);
    expect(await readFile(modelPath(root))).toEqual(WEIGHTS);
    expect(existsSync(`${modelPath(root)}.part`)).toBe(false);
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

// Part file is named after the model, not the attempt, so a resumed download can find it.
test("an interrupted download resumes from the part file rather than fetching it again", async () => {
    const root = await workspace();
    const { ctx, panels } = context(root);
    const already = 3 * CHUNK;
    await writeFile(`${modelPath(root)}.part`, WEIGHTS.subarray(0, already));
    const ranges: (string | undefined)[] = [];
    stubFetch((init) => {
        const headers = new Headers(init?.headers);
        ranges.push(headers.get("range") ?? undefined);
        const rest = WEIGHTS.subarray(already);
        return serve(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(rest);
                    controller.close();
                },
            }),
            { "content-length": String(rest.byteLength), "content-range": `bytes ${already}-${WEIGHTS.byteLength - 1}/${WEIGHTS.byteLength}` },
            206,
        );
    });

    await drain("resumed", ctx);
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);

    expect(ranges).toEqual([`bytes=${already}-`]);
    // Full equality only holds if the on-disk prefix was kept and appended to, not overwritten.
    expect(await readFile(modelPath(root))).toEqual(WEIGHTS);
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

test("the translator is re-synced once the server actually serves, not when the download starts", async () => {
    const root = await workspace();
    const { ctx, panels, syncEndpoints } = context(root, true);
    stubFetch(wholeFile, true);

    await drain("serving", ctx);
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);
    await vi.waitFor(() => expect(syncEndpoints).toHaveBeenCalledTimes(1), SETTLES);

    await localModelHandler.remove?.(ctx, "serving", { model: "custom", gpu: "off", url: MODEL_URL });
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

test("a server that never serves leaves the routing table alone", async () => {
    const root = await workspace();
    // Both watcher exits: panel dead, and /health refusing; neither should trigger a sync.
    const { ctx, panels, syncEndpoints } = context(root);
    stubFetch(wholeFile);

    await drain("never-serves", ctx);
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);
    await vi.waitFor(() => expect(existsSync(modelPath(root))).toBe(true), SETTLES);
    expect(syncEndpoints).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

// Native context sizes the KV cache off the model's max window (128K-256K), bigger than the weights; the card's own
// window avoids that.
test("the server is started with the window the card chose, and a quantized cache to fit it", async () => {
    const root = await workspace();
    const { ctx, panels } = context(root);
    stubFetch(wholeFile);

    await drain("bounded", ctx, "131072");
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);

    const command = panels.start.mock.calls[0]?.[1]?.command as string;
    expect(command).toContain("--ctx-size 131072");
    expect(command).toContain("--cache-type-k q8_0");
    expect(command).toContain("--cache-type-v q8_0");
    // --parallel 1 pins slot count: auto defaults to four on this image, each reserving the full --ctx-size again.
    expect(command).toContain("--parallel 1");
    // `--ctx-size 0` means "read it from the model": the one value every card figure can't survive.
    expect(command).not.toContain("--ctx-size 0");

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

test("a custom window reaches the server as the number that was typed", async () => {
    const root = await workspace();
    const { ctx, panels } = context(root);
    stubFetch(wholeFile);

    await drain("typed", ctx, "custom", 98_304);
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);

    expect(panels.start.mock.calls[0]?.[1]?.command as string).toContain("--ctx-size 98304");

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

// Only a hand-edited manifest reaches this: the form itself cannot submit "custom" with nothing typed.
test("a custom window with no number falls back to the default rung, out loud", async () => {
    const root = await workspace();
    const { ctx, panels } = context(root);
    stubFetch(wholeFile);

    const lines: string[] = [];
    for await (const line of localModelHandler.apply(ctx, "unfinished", { model: "custom", gpu: "off", url: MODEL_URL, context: "custom" })) {
        lines.push((line as { message?: string }).message ?? "");
    }
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);

    expect(panels.start.mock.calls[0]?.[1]?.command as string).toContain(`--ctx-size ${LOCAL_MODEL_WINDOW_DEFAULT}`);
    expect(lines.join("\n")).toMatch(/64k tokens/);

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

// Silence would be the real failure: without this message, a 16k entry and a 64k one look identical from the row.
test("a window under the agent floor is served, and says what it is still good for", async () => {
    const root = await workspace();
    const { ctx } = context(root);
    stubFetch(wholeFile);

    const lines: string[] = [];
    for await (const line of localModelHandler.apply(ctx, "quick", { model: "custom", gpu: "off", url: MODEL_URL, context: "16384" })) {
        lines.push((line as { message?: string }).message ?? "");
    }

    const said = lines.join("\n");
    expect(said).toMatch(/16k tokens/);
    expect(said).toMatch(/full agent turn/i);
    expect(said).toMatch(/card/i);

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});
