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

const context = (root: string): { ctx: CapabilityCtx; panels: Panels } => {
    const panels: Panels = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const ctx = {
        workspace: { root },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        panels: { ...panels, running: () => false },
        capabilities: { list: async () => [] },
        endpointModels: { forget: async () => undefined },
    } as unknown as CapabilityCtx;
    return { ctx, panels };
};

// The health probe answers "not serving" throughout: these tests are about the weights arriving, and a card
// that claimed to be serving would just hide the states being asserted on.
const serve = (body: ReadableStream<Uint8Array>, headers: Record<string, string>, status: number): Response =>
    new Response(body, { status, headers });

const stubFetch = (onModel: (init: RequestInit | undefined) => Response): void => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(MODEL_URL)) {
            return onModel(init);
        }
        return new Response(null, { status: 503 });
    });
};

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
