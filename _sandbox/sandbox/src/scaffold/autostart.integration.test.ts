import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../composition.js";
import { readAutostart, recordAutostart, runAutostart } from "./autostart.js";

/* WHAT EVERY BOOT AFTER THE FIRST DEPENDS ON. The seed records the starter here and the boot step starts what is
 * recorded; a woken hosted machine, a restarted daemon and a prewarmed pool volume all reach the starter's dev
 * server only through this file, so its two halves are tested against a real workspace directory. */

let root: string;
let started: { key: string; spec: { command: string; cwd: string } }[];

const services = (): Services =>
    ({
        workspace: { root },
        config: { zone: "sbx.test", connectToken: "", sandbox: { publicUrl: "" } },
        processes: { start: vi.fn((key: string, spec: { command: string; cwd: string }) => Promise.resolve(void started.push({ key, spec }))) },
    }) as unknown as Services;

const app = async (repo: string, name: string, pkg: string | undefined): Promise<void> => {
    const dir = join(root, repo, "_apps", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), pkg === undefined ? "{}\n" : `${JSON.stringify({ name: pkg, scripts: { dev: "astro dev" } })}\n`);
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-autostart-"));
    started = [];
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("autostart", () => {
    it("records an app once, however many times the seed says so", async () => {
        await recordAutostart(root, { repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" });
        await recordAutostart(root, { repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" });
        await recordAutostart(root, { repo: "shop", app: "api", dev: "pnpm --filter {pkg} dev" });
        expect(await readAutostart(root)).toEqual([
            { repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" },
            { repo: "shop", app: "api", dev: "pnpm --filter {pkg} dev" },
        ]);
        // Tracked workspace configuration, in the state dir the root repo carves back out of its excludes.
        expect(JSON.parse(await readFile(join(root, ".intentic", "config", "autostart.json"), "utf8"))).toEqual({
            apps: [
                { repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" },
                { repo: "shop", app: "api", dev: "pnpm --filter {pkg} dev" },
            ],
        });
    });

    it("starts what is recorded, under the process manager's key, with the app's real package name filled in", async () => {
        await app("site", "landing", "@app_/landing");
        await recordAutostart(root, { repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" });

        expect(await runAutostart(services())).toEqual({ started: ["site--landing"], skipped: [] });
        expect(started).toHaveLength(1);
        expect(started[0]?.key).toBe("site--landing");
        expect(started[0]?.spec.cwd).toBe(join(root, "site"));
        expect(started[0]?.spec.command).toContain("pnpm --filter @app_/landing dev");
    });

    it("skips an app whose folder is gone or unnamed, and says so, without touching the rest", async () => {
        await app("site", "landing", "@app_/landing");
        await app("site", "nameless", undefined);
        await recordAutostart(root, { repo: "site", app: "gone", dev: "pnpm --filter {pkg} dev" });
        await recordAutostart(root, { repo: "site", app: "nameless", dev: "pnpm --filter {pkg} dev" });
        await recordAutostart(root, { repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" });

        expect(await runAutostart(services())).toEqual({
            started: ["site--landing"],
            skipped: [
                { key: "site--gone", why: "its folder is gone" },
                { key: "site--nameless", why: "no named package.json" },
            ],
        });
        expect(started.map((entry) => entry.key)).toEqual(["site--landing"]);
    });

    it("starts nothing on a workspace with no list, which is every workspace seeded before this existed", async () => {
        expect(await runAutostart(services())).toEqual({ started: [], skipped: [] });
        expect(started).toEqual([]);
    });
});
