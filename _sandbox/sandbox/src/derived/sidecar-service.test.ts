import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import { startSidecarService, type ExecFn } from "./sidecar-service.js";

/* The trigger logic apart from any filesystem or child process: what gets a spawn, what gets a sweep, what
 * gets dropped. The exec seam records invocations; a manual subscribe stands in for the watcher. */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

interface Harness {
    readonly emit: (paths: string[]) => void;
    readonly calls: string[][];
    readonly settle: () => Promise<void>;
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
    const stop = startSidecarService(
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
        stop,
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
        const stop = startSidecarService(
            {
                enabled: async () => true,
                logger: { info: () => {}, warn, error: () => {} } as unknown as Logger,
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
        stop();
    });
});
