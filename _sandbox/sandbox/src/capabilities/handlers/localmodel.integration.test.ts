import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { LOCAL_MODEL_WINDOW_DEFAULT, type LocalModelConfig } from "@intentic/sandbox-contract";
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

/* The add, run to the end of its (now short) stream. The window is a parameter because it is a parameter of the
 * card: the tests about the download pass none and get the default, the ones about the flag pass the rung or the
 * typed number they are asserting on. */
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
 * figures drifting away from what the server actually reserves, because the drift is invisible from either side
 * on its own: the label is a string in the catalog and the allocation is a flag here.
 *
 * TWO BUGS ARE LOCKED OUT AND THEY PULL IN OPPOSITE DIRECTIONS. Asking the server for the model's native
 * context ("as much as it was trained for", which reads like generosity) sizes the conversation cache off a
 * 128K-256K window, and that cache is then bigger than the weights: a 3B whose card said "~4 GB" reserved 14 GB
 * of it, a 30B whose card said "~24 GB" reserved 24 GB on top of 17 GB of weights. Both numbers are measured
 * off the GGUF metadata of models on the curated list, and neither machine described by those labels can serve
 * what it was sold. The other direction is the flat 32,768 that replaced it, which no full agent turn fits in:
 * that is why the window is now the card's own field and why the flag has to FOLLOW it rather than ignore it.
 *
 * The quantized cache is asserted alongside because it is what makes any of the rungs affordable, and the
 * native-window spelling is asserted absent, because it is the one value that makes every figure unachievable. */
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
    /* ONE SLOT, which is the other multiplier on the same reservation and the one nobody had looked at: the
     * default is auto, auto is four slots on this image, each slot gets the whole --ctx-size, and a server with
     * one caller can use one of them. A live entry was measured reserving 4 x 32,768 against a card that had
     * priced 32,768. Without this flag every memory figure on the card is out by 4x again. */
    expect(command).toContain("--parallel 1");
    // The regression itself: "read it from the model" is the one value that makes every figure unachievable.
    expect(command).not.toContain("--ctx-size 0");

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

/* THE TYPED NUMBER, which is the field's whole reason for existing: the rungs are for people who want to be
 * told what to pick, and this is for somebody who already knows their machine. It reaches the flag verbatim,
 * because a number silently rounded to the nearest rung is a card lying about a value it accepted. */
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

/* "CUSTOM" WITH NOTHING TYPED, which the form cannot submit and a hand-edited manifest can. It lands on the
 * default rung rather than refusing (the window has a perfectly good answer available, unlike a card that cannot
 * name which bytes to fetch) and the apply says which number it landed on, so the fallback is visible. */
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
    expect(lines.join("\n")).toContain("Conversation window: 64k tokens");

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

/* WHAT A WINDOW TOO SMALL FOR THE LOOP MUST SAY, at the moment the choice is still fresh rather than after the
 * download and a refused message. Not an error: the entry will serve, and as a quick model it is a fine trade.
 * Silence is the failure mode, because from the row alone a 16k entry and a 64k one look identical. */
test("a window under the agent floor is served, and says what it is still good for", async () => {
    const root = await workspace();
    const { ctx } = context(root);
    stubFetch(wholeFile);

    const lines: string[] = [];
    for await (const line of localModelHandler.apply(ctx, "quick", { model: "custom", gpu: "off", url: MODEL_URL, context: "16384" })) {
        lines.push((line as { message?: string }).message ?? "");
    }

    const said = lines.join("\n");
    expect(said).toContain("Conversation window: 16k tokens");
    expect(said).toContain("not for a full agent turn");
    expect(said).toContain("Raise it on the card");

    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});
