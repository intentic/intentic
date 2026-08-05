import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addAppsToMonorepo, injectApps, injectMonorepoShell } from "./inject-template.js";
import { readTemplateManifest, type TemplateManifest } from "./template-manifest.js";

// Runs against the real canonical template repo (the injector's whole job is to copy its packages into a repo),
// so it only runs where that checkout is present — otherwise there is nothing to inject.
const CANONICAL = process.env["INTENTIC_CANONICAL_DIR"] ?? "/home/radarsu/radarsu/repositories/00-canonical-repo";
const hasCanonical = existsSync(join(CANONICAL, "templates.json"));
const readJson = async (path: string): Promise<{ name: string; scripts?: Record<string, string> }> => JSON.parse(await readFile(path, "utf8"));

describe.skipIf(!hasCanonical)("monorepo scaffold + app injection", () => {
    let root: string;
    let repoDir: string;
    let manifest: TemplateManifest;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "intentic-inject-"));
        repoDir = join(root, "shop");
        manifest = readTemplateManifest(CANONICAL);
        await injectMonorepoShell({ repoDir, sourceDir: CANONICAL, manifest });
    });
    afterAll(async () => rm(root, { recursive: true, force: true }));

    test("the empty monorepo has the shell + shared packages, git, and no apps", () => {
        for (const shell of ["package.json", "pnpm-workspace.yaml", "turbo.json"]) {
            expect(existsSync(join(repoDir, shell))).toBe(true);
        }
        for (const shared of ["_libs/ui", "_tools/tsconfig", "_tools/localhost-https"]) {
            expect(existsSync(join(repoDir, shared))).toBe(true);
        }
        expect(existsSync(join(repoDir, ".git"))).toBe(true);
        // Empty until an app is injected — no _apps package lands from the shell alone.
        expect(existsSync(join(repoDir, "_apps"))).toBe(false);
    });

    test("injecting api + web (name = template key) lays down their instance packages verbatim", async () => {
        await injectApps({
            repoDir,
            sourceDir: CANONICAL,
            manifest,
            apps: [
                { template: "api", name: "api" },
                { template: "web", name: "web" },
            ],
        });
        for (const dir of ["_apps/api", "_apps/web", "_libs/api-contract", "_libs/prisma"]) {
            expect(existsSync(join(repoDir, dir))).toBe(true);
        }
        // Packages keep their canonical names when name === template key.
        expect((await readJson(join(repoDir, "_apps/web/package.json"))).name).toBe("@app_/web");
    });

    test("injecting landing alone adds only its instance package", async () => {
        const marketing = join(root, "marketing");
        await injectMonorepoShell({ repoDir: marketing, sourceDir: CANONICAL, manifest });
        await injectApps({ repoDir: marketing, sourceDir: CANONICAL, manifest, apps: [{ template: "landing", name: "landing" }] });
        expect(existsSync(join(marketing, "_apps/landing"))).toBe(true);
        expect(existsSync(join(marketing, "_apps/api"))).toBe(false);
        expect(existsSync(join(marketing, "_libs/ui"))).toBe(true); // shared package from the shell still present
    });

    test("throws on an unknown app", async () => {
        await expect(injectApps({ repoDir, sourceDir: CANONICAL, manifest, apps: [{ template: "nope", name: "nope" }] })).rejects.toThrow(
            /unknown app/,
        );
    });

    test("injecting a second api with a different name creates a renamed instance alongside the first", async () => {
        const multi = join(root, "multi");
        await injectMonorepoShell({ repoDir: multi, sourceDir: CANONICAL, manifest });
        await injectApps({ repoDir: multi, sourceDir: CANONICAL, manifest, apps: [{ template: "api", name: "api" }] });
        await injectApps({ repoDir: multi, sourceDir: CANONICAL, manifest, apps: [{ template: "api", name: "admin-api" }] });

        // Both app dirs exist.
        expect(existsSync(join(multi, "_apps/api"))).toBe(true);
        expect(existsSync(join(multi, "_apps/admin-api"))).toBe(true);

        // The original keeps its canonical name; the renamed instance gets the new name.
        expect((await readJson(join(multi, "_apps/api/package.json"))).name).toBe("@app_/api");
        expect((await readJson(join(multi, "_apps/admin-api/package.json"))).name).toBe("@app_/admin-api");

        // Shared libs land once — they're present but not duplicated.
        expect(existsSync(join(multi, "_libs/api-contract"))).toBe(true);
        expect(existsSync(join(multi, "_libs/prisma"))).toBe(true);
    });

    test("addAppsToMonorepo streams its step lines while injecting (install skipped)", async () => {
        const streamed = join(root, "streamed");
        await injectMonorepoShell({ repoDir: streamed, sourceDir: CANONICAL, manifest });
        // The generator clones its source, so pass the canonical checkout's own branch as the ref.
        const { stdout } = await promisify(execFile)("git", ["-C", CANONICAL, "rev-parse", "--abbrev-ref", "HEAD"]);
        const lines: string[] = [];
        const progress = addAppsToMonorepo({
            repoDir: streamed,
            source: CANONICAL,
            ref: stdout.trim(),
            apps: [{ template: "api", name: "api" }],
            install: false,
        });
        for await (const line of progress) {
            lines.push(line);
        }
        expect(lines[0]).toMatch(/template source/);
        expect(lines.some((line) => line.includes("Adding api"))).toBe(true);
        expect(existsSync(join(streamed, "_apps/api"))).toBe(true);
    });

    test("injecting multiple webs in one call creates separate renamed instances", async () => {
        const multiWeb = join(root, "multi-web");
        await injectMonorepoShell({ repoDir: multiWeb, sourceDir: CANONICAL, manifest });
        await injectApps({
            repoDir: multiWeb,
            sourceDir: CANONICAL,
            manifest,
            apps: [
                { template: "web", name: "shop-web" },
                { template: "web", name: "portal-web" },
            ],
        });

        expect(existsSync(join(multiWeb, "_apps/shop-web"))).toBe(true);
        expect(existsSync(join(multiWeb, "_apps/portal-web"))).toBe(true);
        expect((await readJson(join(multiWeb, "_apps/shop-web/package.json"))).name).toBe("@app_/shop-web");
        expect((await readJson(join(multiWeb, "_apps/portal-web/package.json"))).name).toBe("@app_/portal-web");

        // Shared _libs/api-contract lands once (both web templates list it).
        expect(existsSync(join(multiWeb, "_libs/api-contract"))).toBe(true);
    });
});
