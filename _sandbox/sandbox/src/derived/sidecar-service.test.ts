import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { ExecFn } from "./fileq.js";
import { startSidecarService, type SidecarService } from "./sidecar-service.js";

/* The trigger logic apart from any filesystem or child process: what gets a spawn, what gets a sweep, what gets dropped. */

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

interface Harness {
    readonly emit: (paths: string[]) => void;
    readonly calls: string[][];
    readonly settle: () => Promise<void>;
    readonly service: SidecarService;
    readonly stop: () => void;
}

const harness = (options: { enabled?: () => Promise<boolean>; exec?: ExecFn } = {}): Harness => {
    const calls: string[][] = [];
    const exec: ExecFn =
        options.exec ??
        (async (_command, args) => {
            calls.push(args);
            return { stdout: "{}" };
        });
    let listener: ((paths: string[]) => void) | undefined;
    const service = startSidecarService(
        { enabled: options.enabled ?? (async () => true), logger, exec },
        (l) => {
            listener = l;
            return () => {
                listener = undefined;
            };
        },
    );
    return {
        emit: (paths) => listener?.(paths),
        calls,
        // The queue chains promises; two microtask hops let a scheduled run start and finish.
        settle: async () => {
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
        },
        service,
        stop: service.stop,
    };
};

describe("the sidecar trigger", () => {
    test("enabled at boot sweeps the pre-existing tree before any batch arrives", async () => {
        const h = harness();
        await h.settle();
        expect(h.calls[0]?.[0]).toBe("sweep");
        h.stop();
    });

    test("a batch touching candidates derives exactly those; code edits never cost a spawn", async () => {
        const h = harness();
        await h.settle(); // boot sweep out of the way
        h.emit(["src/index.ts", "docs/plan.docx", "README.md", "assets/photo.png"]);
        await h.settle();
        const derive = h.calls.find((args) => args[0] === "derive");
        expect(derive).toEqual(["derive", "docs/plan.docx", "assets/photo.png"]);
        h.emit(["src/only-code.ts"]);
        await h.settle();
        expect(h.calls.filter((args) => args[0] === "derive")).toHaveLength(1);
        h.stop();
    });

    test("the watcher's empty too-many-paths frame becomes a sweep, the path list being gone", async () => {
        const h = harness();
        await h.settle();
        h.emit([]);
        await h.settle();
        expect(h.calls.filter((args) => args[0] === "sweep")).toHaveLength(2);
        h.stop();
    });

    test("disabled drops batches; flipping the setting on sweeps without a restart", async () => {
        let on = false;
        const h = harness({ enabled: async () => on });
        await h.settle();
        h.emit(["docs/plan.docx"]);
        await h.settle();
        expect(h.calls).toHaveLength(0);
        on = true;
        h.emit([".intentic/config/settings.json"]);
        await h.settle();
        expect(h.calls[0]?.[0]).toBe("sweep"); // off→on converges the whole tree, not just the settings file
        h.stop();
    });

    test("a missing fileq binary stands the service down after one warning, not one warning per batch", async () => {
        const failing: ExecFn = async () => {
            const error = new Error("spawn fileq ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
        };
        const warn = vi.fn();
        const h = harness({ exec: failing });
        // Recreate with a spying logger: the harness's default logger swallows.
        h.stop();
        const calls: string[][] = [];
        let listener: ((paths: string[]) => void) | undefined;
        const service = startSidecarService(
            {
                enabled: async () => true,
                logger: { info: () => {}, warn, error: () => {}, debug: () => {} } as unknown as Logger,
                exec: async (command, args, options) => {
                    calls.push(args);
                    return failing(command, args, options);
                },
            },
            (l) => {
                listener = l;
                return () => {};
            },
        );
        await h.settle();
        listener?.(["docs/plan.docx"]);
        await h.settle();
        listener?.(["docs/other.pdf"]);
        await h.settle();
        expect(calls).toHaveLength(1); // the boot sweep died on ENOENT; nothing after it spawned
        expect(warn).toHaveBeenCalledTimes(1);
        expect(service.status().broken).toBe(true);
        service.stop();
    });
});

describe("what the service says about itself", () => {
    test("names the paths whose text it just wrote, so a reader watching one learns it landed", async () => {
        const h = harness();
        await h.settle(); // boot sweep out of the way
        const landed: string[][] = [];
        h.service.onDerived((paths) => landed.push(paths));
        h.emit(["docs/plan.docx", "src/index.ts"]);
        await h.settle();
        // Only the candidates: a code edit never reached the queue, so nothing claims its shadow was rewritten.
        expect(landed).toEqual([["docs/plan.docx"]]);
        h.stop();
    });

    test("a sweep announces an unnamed set, since it rewrites what it found and does not report which", async () => {
        const h = harness();
        const landed: string[][] = [];
        h.service.onDerived((paths) => landed.push(paths));
        await h.settle();
        expect(landed).toEqual([[]]);
        h.stop();
    });

    test("counts the shadows a sweep left behind, which is the pair that exists afterwards", async () => {
        const h = harness({ exec: async () => ({ stdout: `{"derived":3,"fresh":84,"removed":0,"skipped":0,"pruned":0}` }) });
        await h.settle();
        expect(h.service.status().shadows).toBe(87);
        expect(h.service.status().sweptAt).toEqual(expect.any(String));
        h.stop();
    });

    test("a file waiting is not a file nobody has read: the queue holds it until its batch runs", async () => {
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let first = true;
        const h = harness({
            exec: async () => {
                if (first) {
                    first = false;
                    return { stdout: "{}" }; // the boot sweep
                }
                await held;
                return { stdout: "{}" };
            },
        });
        await h.settle();
        h.emit(["a.docx", "b.pdf"]);
        await h.settle();
        // Both left `pending` for the one batch in flight, which is what makes "being read" a different answer.
        expect(h.service.status().deriving).toEqual(["a.docx", "b.pdf"]);
        expect(h.service.status().queued).toBe(0);
        release();
        await h.settle();
        expect(h.service.status().deriving).toEqual([]);
        h.stop();
    });

    test("switched off reports itself off rather than idle, which is a different thing to tell a reader", async () => {
        const h = harness({ enabled: async () => false });
        await h.settle();
        expect(h.service.status().enabled).toBe(false);
        expect(h.service.status().sweeping).toBe(false);
        h.stop();
    });
});
