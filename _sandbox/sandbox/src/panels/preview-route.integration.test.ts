import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portSlotsFromToken, publicSlotFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspacePaths } from "../workspace/workspace.js";

// The names are attached by the box's OWN agent now (a name claimed, then a share bound to it), not by asking
// the platform to mint DNS, so the seam these tests hold is the pair of agent invocations per label.
const execMock = vi.fn<(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>();
vi.mock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile: (file: string, args: readonly string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        execMock(file, args).then(
            (result) => callback(null, result.stdout, result.stderr),
            (error: Error) => callback(error, "", ""),
        );
    },
}));

const { createPreviewRouteEnsurer, ensureAllPreviewRoutes } = await import("./preview-route.js");

const config = (token = "acct-token", namespace = "ns-1"): Parameters<typeof createPreviewRouteEnsurer>[0] =>
    ({ zrok: { token, api: "", namespace }, preview: { port: 5173 } }) as unknown as Parameters<typeof createPreviewRouteEnsurer>[0];
const warn = vi.fn();
const logger = { warn } as unknown as Parameters<typeof createPreviewRouteEnsurer>[1];

beforeEach(() => {
    execMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    warn.mockClear();
});

describe("createPreviewRouteEnsurer", () => {
    it("claims and binds each label once, then memoizes it: a re-ensure spawns no agent", async () => {
        const ensure = createPreviewRouteEnsurer(config(), logger);
        await ensure(["preview-app", "port-a"]);
        await ensure(["preview-app"]);
        await ensure(["port-a"]);
        // Two calls per label: the name in the namespace, then the share bound to it.
        expect(execMock).toHaveBeenCalledTimes(4);
        const [file, claim] = execMock.mock.calls[0]!;
        expect(file).toBe("zrok2");
        expect(claim).toEqual([`create`, `name`, `preview-app`, `--namespace-token`, `ns-1`]);
        // Every preview name points at the ONE preview proxy: it already routes by Host header.
        expect(execMock.mock.calls[1]![1]).toEqual([
            `share`,
            `public`,
            `http://127.0.0.1:5173`,
            `--backend-mode`,
            `proxy`,
            `--name-selection`,
            `ns-1:preview-app`,
        ]);
        // A batch with one new label attaches ONLY the missing one.
        await ensure(["preview-app", "preview-other"]);
        expect(execMock).toHaveBeenCalledTimes(6);
        expect(execMock.mock.calls.at(-1)![1]).toContain("ns-1:preview-other");
    });

    it("never rejects: a failure warns and is retried on the next ensure", async () => {
        execMock.mockRejectedValueOnce(new Error("hub down"));
        const ensure = createPreviewRouteEnsurer(config(), logger);
        await expect(ensure(["preview-app"])).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        await ensure(["preview-app"]);
        expect(execMock).toHaveBeenCalledTimes(3);
        // Now memoized.
        await ensure(["preview-app"]);
        expect(execMock).toHaveBeenCalledTimes(3);
    });

    /* A name the hub already holds for this account, and a share already bound to it, are the steady state
     * after any restart: both answer 409 and neither is a failure. */
    it("treats an already-claimed name and an already-bound share as done, silently", async () => {
        execMock.mockRejectedValueOnce(new Error("[409] createShareNameConflict"));
        const ensure = createPreviewRouteEnsurer(config(), logger);
        await ensure(["preview-app"]);
        expect(warn).not.toHaveBeenCalled();
        // The claim conflicted, the bind still ran: two calls, and the label counts as attached.
        expect(execMock).toHaveBeenCalledTimes(2);
        await ensure(["preview-app"]);
        expect(execMock).toHaveBeenCalledTimes(2);

        execMock
            .mockReset()
            .mockResolvedValue({ stdout: "", stderr: "" })
            .mockRejectedValueOnce(new Error("name 'port-a' in namespace 'public' is already in use by another share"));
        await createPreviewRouteEnsurer(config(), logger)(["port-a"]);
        expect(warn).not.toHaveBeenCalled();
    });

    it("is a no-op without a reachability grant (an attached domain, or loopback dev)", async () => {
        await createPreviewRouteEnsurer(config(""), logger)(["preview-app"]);
        expect(execMock).not.toHaveBeenCalled();
    });
});

describe("ensureAllPreviewRoutes", () => {
    it("ensures every discovered repo + the whole port-slot pool + the outbox in one batch: the boot-time pre-mint", async () => {
        const root = mkdtempSync(join(tmpdir(), "preview-sweep-"));
        mkdirSync(join(root, "intent", ".git"), { recursive: true });
        mkdirSync(join(root, "extra", ".git"), { recursive: true });
        const batches: (readonly string[])[] = [];
        await ensureAllPreviewRoutes({
            workspace: workspacePaths(root),
            // The port-slot and outbox labels are derived from this, so the stub has to carry one for them to exist.
            config: { connectToken: "" },
            ensurePreviewRoutes: async (labels: readonly string[]) => {
                batches.push(labels);
            },
        } as unknown as Parameters<typeof ensureAllPreviewRoutes>[0]);
        expect(batches).toHaveLength(1);
        expect(batches[0]!.toSorted()).toEqual(
            [
                "preview-extra",
                "preview-intent",
                ...portSlotsFromToken("").map((slot) => `port-${slot}`),
                `public-${publicSlotFromToken("")}`,
            ].toSorted(),
        );
    });
});
