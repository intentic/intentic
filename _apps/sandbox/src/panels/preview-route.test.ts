import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspacePaths } from "../workspace/workspace.js";

const postMock = vi.fn<(config: unknown, path: string, body: unknown) => Promise<{ status: number; json: unknown }>>();
vi.mock("../platform/platform-client.js", () => ({ postToPlatform: (...args: unknown[]) => postMock(...(args as Parameters<typeof postMock>)) }));

const { createPreviewRouteEnsurer, ensureAllPreviewRoutes } = await import("./preview-route.js");

const config = (platformUrl = "https://p", connectToken = "tok"): Parameters<typeof createPreviewRouteEnsurer>[0] =>
    ({ platform: { url: platformUrl }, connectToken }) as unknown as Parameters<typeof createPreviewRouteEnsurer>[0];
const warn = vi.fn();
const logger = { warn } as unknown as Parameters<typeof createPreviewRouteEnsurer>[1];

beforeEach(() => {
    postMock.mockReset();
    warn.mockClear();
});

describe("createPreviewRouteEnsurer", () => {
    it("posts the panel once and memoizes the 2xx — a re-start costs no platform call", async () => {
        postMock.mockResolvedValue({ status: 200, json: { hostname: "x" } });
        const ensure = createPreviewRouteEnsurer(config(), logger);
        await ensure("app");
        await ensure("app");
        expect(postMock).toHaveBeenCalledTimes(1);
        expect(postMock).toHaveBeenCalledWith(expect.anything(), "/sandbox/preview-route", { panel: "app" });
    });

    it("never rejects: a non-2xx warns and is retried on the next start; a transport error too", async () => {
        postMock.mockResolvedValueOnce({ status: 502, json: undefined });
        postMock.mockRejectedValueOnce(new Error("down"));
        postMock.mockResolvedValueOnce({ status: 200, json: {} });
        const ensure = createPreviewRouteEnsurer(config(), logger);
        await expect(ensure("app")).resolves.toBeUndefined();
        await expect(ensure("app")).resolves.toBeUndefined();
        await ensure("app");
        expect(postMock).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledTimes(2);
        // Now memoized.
        await ensure("app");
        expect(postMock).toHaveBeenCalledTimes(3);
    });

    it("serializes concurrent ensures — the tunnel config update is a read-modify-write on the platform", async () => {
        const gate = Promise.withResolvers<{ status: number; json: unknown }>();
        postMock.mockImplementationOnce(() => gate.promise);
        postMock.mockResolvedValueOnce({ status: 200, json: {} });
        const ensure = createPreviewRouteEnsurer(config(), logger);
        const first = ensure("a");
        const second = ensure("b");
        // Flush the chained microtask: "a" is in flight, "b" must wait for it.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(postMock).toHaveBeenCalledTimes(1);
        gate.resolve({ status: 200, json: {} });
        await Promise.all([first, second]);
        expect(postMock).toHaveBeenCalledTimes(2);
    });

    it("is a no-op without a platform or connect token (loopback/headless)", async () => {
        await createPreviewRouteEnsurer(config(""), logger)("app");
        await createPreviewRouteEnsurer(config("https://p", ""), logger)("app");
        expect(postMock).not.toHaveBeenCalled();
    });
});

describe("ensureAllPreviewRoutes", () => {
    it("ensures every discovered repo (role dirs + extras) — the boot-time self-heal", async () => {
        const root = mkdtempSync(join(tmpdir(), "preview-sweep-"));
        mkdirSync(join(root, "intent", ".git"), { recursive: true });
        mkdirSync(join(root, "extra", ".git"), { recursive: true });
        const ensured: string[] = [];
        await ensureAllPreviewRoutes({
            workspace: workspacePaths(root),
            ensurePreviewRoute: async (panel: string) => {
                ensured.push(panel);
            },
        } as unknown as Parameters<typeof ensureAllPreviewRoutes>[0]);
        expect(ensured.toSorted()).toEqual(["extra", "intent"]);
    });
});
