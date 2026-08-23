import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import type { CapabilityCtx } from "../capability.js";

/* WHAT THE ADD PROMISES ABOUT A DOWNLOAD IT DOES NOT WAIT FOR.
 *
 * These two are the whole reason the handler stopped streaming its weights to the caller. The card that used to
 * hold a spinner for forty minutes had no way to say how far along it was, and a browser that walked away took
 * the download with it, so both facts are pinned against a real file on a real disk rather than against the
 * shape of the code: apply RETURNS while the bytes are still arriving, `status` can say how far along they are
 * while it does, and a part file left by a stopped daemon is CONTINUED rather than fetched again.
 *
 * The custom-URL source is used throughout because it is the branch a test can serve itself; the Hugging Face
 * branch differs only in who hands over the stream (hub's blob, sliced to the same offset). */

// `llama-server --version` answers, so the handler takes its real path on a runner that has no llama-server:
// without this the whole suite would exercise the "stored, rebuild required" branch and assert nothing.
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        execFile: (_file: string, _args: readonly string[], done: (error: Error | null, stdout: string, stderr: string) => void) => {
            done(null, "", "");
        },
    };
});

const { localModelHandler } = await import("./localmodel.js");

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

// `panelRunning` is what the serving watcher polls alongside /health, so a test that wants the watcher to keep
// looking has to say the server is up; the default is the dead-panel exit, which is what stops every test that
// is not about the watcher from leaving one running.
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

// The health probe answers "not serving" unless a test says otherwise: most of these are about the weights
// arriving, and a card that claimed to be serving would just hide the states being asserted on.
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

// Whole weights in one chunk, the shape every test that isn't about resuming wants.
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

// The add, run to the end of its (now short) stream.
const drain = async (id: string, ctx: CapabilityCtx): Promise<void> => {
    for await (const line of localModelHandler.apply(ctx, id, { model: "custom", gpu: "off", url: MODEL_URL })) {
        void line;
    }
};

const statusOf = (ctx: CapabilityCtx, id: string) => localModelHandler.status(ctx, id, { model: "custom", gpu: "off", url: MODEL_URL });

/* The add's own promise: it comes back while the bytes are still moving, and what it leaves behind is a card
 * that can be asked. This is the regression that mattered, an apply that streamed to the end of the download
 * left the form with a spinner and the reader with no way to tell a working download from a wedged one. */
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

    // Returns at all, with the download deliberately wedged open: the assertion is that this line is reached.
    await drain("held-open", ctx);
    expect(existsSync(modelPath(root))).toBe(false);

    // …and the card, which is the surface that survives a page refresh, can say how far along it is.
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

/* WHAT A RESTART COSTS. The part file is named after the model rather than after the attempt precisely so the
 * next attempt can find it: a daemon that stopped nineteen gigabytes into a twenty-gigabyte download must ask
 * for the twentieth, not for all twenty. Asserted through the bytes on disk, the prefix has to survive. */
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
    // The whole model, which is only true if the three chunks already on disk were kept and appended to.
    expect(await readFile(modelPath(root))).toEqual(WEIGHTS);
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

/* THE REGRESSION THAT MADE EVERY LOCAL MODEL UNUSABLE, and the reason this file asserts on a sync at all.
 *
 * The capability route syncs the translator's routing table when the entry is ADDED, which for this kind is
 * minutes before it can serve: the weights are still arriving, the endpoint publishes no models, and the route
 * writes `models: []`. Nothing else in the daemon watches for that to stop being true, so the table kept saying
 * the endpoint served nothing while llama-server sat healthy on loopback, and every turn came back "unknown
 * provider for model <id>/<model>" against a card reading "active".
 *
 * So: the sync must happen AFTER the server answers /health, not when the download was handed off. */
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

/* The other half of the same rule: a server that never comes up must not be announced as routable. A sync on
 * spawn rather than on readiness would publish the endpoint's model list from a catalog read that answers
 * nothing, which is the empty-list entry this whole watcher exists to stop being written. */
test("a server that never serves leaves the routing table alone", async () => {
    const root = await workspace();
    // Panel dead and /health refusing: the watcher's two exits, neither of which may reach a sync.
    const { ctx, panels, syncEndpoints } = context(root);
    stubFetch(wholeFile);

    await drain("never-serves", ctx);
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);
    await vi.waitFor(() => expect(existsSync(modelPath(root))).toBe(true), SETTLES);
    expect(syncEndpoints).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

/* THE MEMORY THE CARD PROMISED, PINNED AS A COMMAND LINE. This is the assertion that stops the card's RAM
 * labels drifting away from what the server actually reserves, because the drift is invisible from either side
 * on its own: the label is a string in the catalog and the allocation is a flag here.
 *
 * The bug it locks out shipped once. Asking the server for the model's native context ("as much as it was
 * trained for", which reads like generosity) sizes the conversation cache off a 128K-256K window, and that
 * cache is then bigger than the weights: a 3B whose card said "~4 GB" reserved 14 GB of it, a 30B whose card
 * said "~24 GB" reserved 24 GB on top of 17 GB of weights. Both numbers are measured off the GGUF metadata of
 * models on the curated list, and neither machine described by those labels can serve what it was sold.
 *
 * So both halves are asserted together, and the negative is asserted too: a capped window AND a quantized
 * cache, because dropping either one puts the reservation back into the gigabytes the labels do not carry. */
test("the server is started with a capped, quantized conversation cache, not the model's native window", async () => {
    const root = await workspace();
    const { ctx, panels } = context(root);
    stubFetch(wholeFile);

    await drain("bounded", ctx);
    await vi.waitFor(() => expect(panels.start).toHaveBeenCalledTimes(1), SETTLES);

    const command = panels.start.mock.calls[0]?.[1]?.command as string;
    expect(command).toContain("--ctx-size 32768");
    expect(command).toContain("--cache-type-k q8_0");
    expect(command).toContain("--cache-type-v q8_0");
    // The regression itself: "read it from the model" is the one value that makes the labels unachievable.
    expect(command).not.toContain("--ctx-size 0");

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});
