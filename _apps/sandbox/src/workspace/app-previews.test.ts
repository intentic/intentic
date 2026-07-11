import type { TemplateManifest } from "@intentic/scaffold";
import { describe, expect, test } from "vitest";
import { appPanelKey, buildAppSpec } from "./app-previews.js";

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

describe("app-previews", () => {
    test("panel key is the <repo>--<app> single label", () => {
        expect(appPanelKey("shop", "web")).toBe("shop--web");
    });

    test("buildAppSpec fills {pkg} with the app's real package name, sibling {previewUrl:*}, and routes {port} to portEnv", () => {
        const apiPreview = MANIFEST.templates["api"]!.previews[0]!;
        // `pkg` is the real package.json name — scoped to the monorepo's OWN scope, not the template's @app_/.
        const spec = buildAppSpec({
            repo: "shop",
            repoDir: "/work/repositories/shop",
            pkg: "@shop/api",
            app: "api",
            preview: apiPreview,
            zone: "z.dev",
            sandboxId: "abc123def456",
        });

        expect(spec.cwd).toBe("/work/repositories/shop");
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
            repoDir: "/work/repositories/shop",
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
});
