import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateManifest, TemplatePreview } from "@intentic/scaffold";
import { previewUrl } from "@intentic/sandbox-contract";

// Per-app previews for a monorepo. Each app instance in the monorepo previews as its OWN dev server: the
// process-manager key is `<repo>--<app>` and the preview host is
// `preview-<repo>--<app>-<sandboxId>.<zone>` (built/parsed by panels/preview-hostname.ts), so the preview
// proxy resolves the first label → portOf("<repo>--<app>"). (`--` can't appear in a monorepo name — the
// capability rejects it — so the key never collides with a plain repo's panel.)

export const appPanelKey = (repo: string, app: string): string => `${repo}--${app}`;

// An app instance present in a monorepo: `app` is the instance name (the `_apps/<app>` dir name, which may
// differ from the template key when the user chose a custom name), `template` is the manifest key it was
// created from (api/web/landing), `pkg` is the app package's real `name` (read from its package.json — the
// `pnpm --filter` target, which is scoped to the monorepo's OWN scope, not the template's), and `preview` is
// the template's preview spec (dev command + port + env).
export interface AppPreview {
    readonly app: string;
    readonly template: string;
    readonly pkg: string;
    readonly preview: TemplatePreview;
}

// Resolve the template key a given `_apps/<name>` instance was created from, given its parsed package.json.
// The inject engine stamps `intentic.template` — read it first. Falls back to checking if the dir name is
// itself a template key (pre-marker canonical instances), then a naming-convention heuristic (instance name
// ends with `-<templateKey>`).
const resolveTemplate = (appName: string, manifest: TemplateManifest, pkg: { intentic?: { template?: string } }): string | undefined => {
    // 1. The intentic.template marker the inject engine stamps.
    if (typeof pkg.intentic?.template === "string" && manifest.templates[pkg.intentic.template] !== undefined) {
        return pkg.intentic.template;
    }
    // 2. Fast path: the dir name IS a template key (pre-marker instance or name === template).
    if (manifest.templates[appName] !== undefined) {
        return appName;
    }
    // 3. Naming-convention fallback: "shop-api" → try template "api" (the suffix after the last hyphen).
    for (const key of Object.keys(manifest.templates)) {
        if (appName.endsWith(`-${key}`)) {
            return key;
        }
    }
    return undefined;
};

// Discover all app instances present in a monorepo's `_apps/` dir and resolve each to its template type.
// Returns one AppPreview per instance × preview combo (a template with multiple previews expands).
export const discoverApps = (repoDir: string, manifest: TemplateManifest): AppPreview[] => {
    const appsDir = join(repoDir, "_apps");
    if (!existsSync(appsDir)) {
        return [];
    }
    const result: AppPreview[] = [];
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const appName = entry.name;
        // A real app instance has a package.json — its `name` is the actual `pnpm --filter` target. A dir
        // without one (or unparseable) isn't a startable app.
        let pkg: { name?: string; intentic?: { template?: string } };
        try {
            pkg = JSON.parse(readFileSync(join(appsDir, appName, "package.json"), "utf8")) as { name?: string; intentic?: { template?: string } };
        } catch {
            continue;
        }
        if (pkg.name === undefined) {
            continue;
        }
        const templateKey = resolveTemplate(appName, manifest, pkg);
        if (templateKey === undefined) {
            continue; // unknown app, not from a known template
        }
        const def = manifest.templates[templateKey];
        if (def === undefined) {
            continue;
        }
        for (const preview of def.previews) {
            result.push({ app: appName, template: templateKey, pkg: pkg.name, preview });
        }
    }
    return result;
};

// An app is present in a monorepo once its `_apps/<app>` package dir has been injected (by addAppsToMonorepo).
export const isAppPresent = (repoDir: string, app: string): boolean => existsSync(join(repoDir, "_apps", app));

// Resolve one app instance's preview into the panel-process spec fields: the dev command (`{pkg}` → the
// scoped package name using the INSTANCE name) run from the repo root after a first-boot install guard, its
// env (sibling `{previewUrl:*}` filled from the zone), and which env vars carry the assigned port (`{port}`
// values — e.g. the Hono API's API_PORT, which doesn't read PORT). The daemon always injects PORT; portEnv
// mirrors it under the app's own var.
export const buildAppSpec = (opts: {
    repo: string;
    repoDir: string;
    pkg: string;
    app: string;
    preview: TemplatePreview;
    zone: string | undefined;
    sandboxId: string | undefined;
}): { command: string; cwd: string; env: Record<string, string>; portEnv: string[] } => {
    // `{pkg}` is the app package's REAL name (discoverApps read it from _apps/<app>/package.json), so the
    // `--filter` matches whatever scope the monorepo actually uses — not the template author's scope.
    const fill = (value: string): string =>
        value
            .replace(/\{pkg\}/g, opts.pkg)
            .replace(/\{name\}/g, opts.repo)
            .replace(
                /\{previewUrl:([a-z0-9-]+)\}/g,
                (_match, sibling: string) => previewUrl(appPanelKey(opts.repo, sibling), opts.zone, opts.sandboxId) ?? "",
            );
    const env: Record<string, string> = {};
    const portEnv: string[] = [];
    for (const [key, value] of Object.entries(opts.preview.env ?? {})) {
        if (value === "{port}") {
            portEnv.push(key);
            continue;
        }
        env[key] = fill(value);
    }
    // `&&` (left-assoc: `(test || install) && dev`) so a failed install stops with ITS error above the prompt
    // instead of burying it under the dev command's cascading failure. No `exec` — the chain runs inside the
    // pane's interactive shell (see panel-processes launch), which must survive the command so Ctrl+C lands at
    // a prompt and ↑ re-runs it.
    return { command: `test -d node_modules || pnpm install && ${fill(opts.preview.dev)}`, cwd: opts.repoDir, env, portEnv };
};
