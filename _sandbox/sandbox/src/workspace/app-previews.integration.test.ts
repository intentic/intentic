import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { TemplateManifest } from "@intentic/scaffold";
import { describe, expect, test } from "vitest";
import { appPanelKey, buildAppSpec, discoverApps } from "./app-previews.js";

// A minimal manifest exercising the two port conventions: web reads PORT (daemon-injected) + a sibling URL;
// api reads a non-PORT var (API_PORT) via the {port} marker + a sibling URL.
const MANIFEST: TemplateManifest = {
    scope: "@app_/",
    shell: [],
    shared: [],
    templates: {
        api: {
            label: "API",
            description: "",
            instance: ["_apps/api"],
            previews: [{ package: "api", dev: "pnpm --filter {pkg} dev", port: 6480, env: { API_PORT: "{port}", WEB_ORIGIN: "{previewUrl:web}" } }],
        },
        web: {
            label: "Web",
            description: "",
            instance: ["_apps/web"],
            previews: [{ package: "web", dev: "pnpm --filter {pkg} dev", port: 4701, env: { API_URL: "{previewUrl:api}" } }],
        },
    },
};

// A monorepo on disk: each entry is an `_apps/<dir>` package.json.
const scaffoldRepo = async (apps: Record<string, object>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "app-previews-"));
    for (const [app, pkg] of Object.entries(apps)) {
        await mkdir(join(dir, "_apps", app), { recursive: true });
        await writeFile(join(dir, "_apps", app, "package.json"), JSON.stringify(pkg));
    }
    return dir;
};

describe("app-previews", () => {
    test("panel key is the <repo>--<app> single label", () => {
        expect(appPanelKey("shop", "web")).toBe("shop--web");
    });

    test("buildAppSpec fills {pkg} with the app's real package name, sibling {previewUrl:*}, and routes {port} to portEnv", () => {
        const apiPreview = MANIFEST.templates["api"]!.previews[0]!;
        // `pkg` is the real package.json name: scoped to the monorepo's OWN scope, not the template's @app_/.
        const spec = buildAppSpec({
            repo: "shop",
            repoDir: `${WORKSPACE_ROOT}/shop`,
            pkg: "@shop/api",
            app: "api",
            preview: apiPreview,
            zone: "z.dev",
            sandboxId: "abc123def456",
        });

        expect(spec.cwd).toBe("/work/shop");
        expect(spec.command).toContain("pnpm --filter @shop/api dev");
        // The Hono API reads API_PORT, not PORT, so {port} becomes a portEnv the manager fills with the assigned port.
        expect(spec.portEnv).toEqual(["API_PORT"]);
        expect(spec.env["API_PORT"]).toBeUndefined();
        // The sibling web app's preview URL is filled from the zone + sandbox id.
        expect(spec.env["WEB_ORIGIN"]).toBe("https://preview-shop--web-abc123def456.z.dev");
    });

    test("buildAppSpec filters by the exact package name for a renamed instance", () => {
        const apiPreview = MANIFEST.templates["api"]!.previews[0]!;
        // A renamed instance "admin-api" whose package name the inject engine set to @shop/admin-api.
        const spec = buildAppSpec({
            repo: "shop",
            repoDir: `${WORKSPACE_ROOT}/shop`,
            pkg: "@shop/admin-api",
            app: "admin-api",
            preview: apiPreview,
            zone: "z.dev",
            sandboxId: "abc123def456",
        });

        expect(spec.command).toContain("pnpm --filter @shop/admin-api dev");
    });

    test("buildAppSpec leaves a sibling URL empty when there is no zone or sandbox id", () => {
        const webPreview = MANIFEST.templates["web"]!.previews[0]!;
        const spec = buildAppSpec({
            repo: "shop",
            repoDir: "/r",
            pkg: "@shop/web",
            app: "web",
            preview: webPreview,
            zone: undefined,
            sandboxId: undefined,
        });
        expect(spec.env["API_URL"]).toBe("");
        expect(spec.portEnv).toEqual([]);
    });

    test("discoverApps takes the preview spec from the manifest for a scaffolded instance", async () => {
        const dir = await scaffoldRepo({ api: { name: "@shop/api" } });
        expect(discoverApps(dir, MANIFEST)).toEqual([{ app: "api", kind: "api", pkg: "@shop/api", preview: MANIFEST.templates["api"]!.previews[0] }]);
    });

    /* The reason an Astro site sitting in `_apps/` used to be invisible: no manifest template matches it. It is
     * still a dev server, so it is still an app, and since `astro dev` ignores the daemon-injected PORT and
     * vite 403s an unrecognized preview Host, the derived command has to pass both on the command line. */
    test("discoverApps finds a framework app with no matching template and passes it the port + preview host", async () => {
        const dir = await scaffoldRepo({ site: { name: "@shop/site", scripts: { dev: "astro dev" }, dependencies: { astro: "^6" } } });
        const [found, ...rest] = discoverApps(dir, MANIFEST);
        expect(rest).toEqual([]);
        expect(found).toEqual({
            app: "site",
            kind: "astro",
            pkg: "@shop/site",
            preview: { dev: `pnpm --filter {pkg} dev --port "$PORT" --host --allowed-hosts` },
        });
        const spec = buildAppSpec({
            repo: "shop",
            repoDir: dir,
            pkg: "@shop/site",
            app: "site",
            preview: found!.preview,
            zone: undefined,
            sandboxId: undefined,
        });
        expect(spec.command).toContain(`pnpm --filter @shop/site dev --port "$PORT" --host --allowed-hosts`);
    });

    // astro/nuxt depend on vite themselves, so the more specific framework has to win the probe.
    test("discoverApps prefers the specific framework over the vite it is built on", async () => {
        const dir = await scaffoldRepo({
            site: { name: "@shop/site", scripts: { dev: "astro dev" }, dependencies: { astro: "^6" }, devDependencies: { vite: "^7" } },
        });
        expect(discoverApps(dir, MANIFEST)[0]?.kind).toBe("astro");
    });

    // A server that reads PORT from the env (bun/node/hono) needs no flags: just the dev script.
    test("discoverApps derives a bare dev command and no kind for an app with no recognized framework", async () => {
        const dir = await scaffoldRepo({ daemon: { name: "@shop/daemon", scripts: { dev: "bun --watch ./src/main.ts" } } });
        expect(discoverApps(dir, MANIFEST)).toEqual([
            { app: "daemon", kind: undefined, pkg: "@shop/daemon", preview: { dev: "pnpm --filter {pkg} dev" } },
        ]);
    });

    // A library in `_apps/` has no dev server, so it is not startable: the apps view lists it under Packages.
    test("discoverApps skips a package with no dev script and a dir with no package.json", async () => {
        const dir = await scaffoldRepo({ cli: { name: "@shop/cli", scripts: { build: "tsc" } } });
        await mkdir(join(dir, "_apps", "empty"), { recursive: true });
        expect(discoverApps(dir, MANIFEST)).toEqual([]);
    });
});
