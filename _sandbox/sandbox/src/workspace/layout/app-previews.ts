import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateManifest, TemplatePreview } from "@intentic/scaffold";
import { previewUrl } from "@intentic/sandbox-contract";

// Per-app preview key: `<repo>--<app>`, matching the preview host `preview-<repo>--<app>-<sandboxId>.<zone>`.
// `--` can't appear in a monorepo name, so this never collides with a plain repo's panel key.

export const appPanelKey = (repo: string, app: string): string => `${repo}--${app}`;

// What running one app instance takes: the dev command and its env, a structural subset of TemplatePreview.
// `port` is author metadata the daemon never reads; the process manager assigns and injects the real port as PORT.
export type AppRun = Pick<TemplatePreview, "dev" | "env">;

// One app instance: app is the _apps/<app> dir name; kind is its template key or detected framework, else undefined.
// pkg is the package's real name (pnpm --filter target, the monorepo's own scope); preview is how to run it.
export interface AppPreview {
    readonly app: string;
    readonly kind: string | undefined;
    readonly pkg: string;
    readonly preview: AppRun;
}

// package.json fields discovery reads: name, intentic.template, the dev script, and framework dependency blocks.
interface AppManifest {
    readonly name?: string;
    readonly intentic?: { readonly template?: string };
    readonly scripts?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
}

// Resolves the template key an instance was created from: the inject engine's intentic.template marker first.
// Then dir name as a template key (pre-marker instances), then dir name ending in `-<templateKey>`.
const resolveTemplate = (appName: string, manifest: TemplateManifest, pkg: AppManifest): string | undefined => {
    if (typeof pkg.intentic?.template === "string" && manifest.templates[pkg.intentic.template] !== undefined) {
        return pkg.intentic.template;
    }
    if (manifest.templates[appName] !== undefined) {
        return appName;
    }
    for (const key of Object.keys(manifest.templates)) {
        if (appName.endsWith(`-${key}`)) {
            return key;
        }
    }
    return undefined;
};

// Frameworks needing explicit port/host flags; order matters since astro/nuxt also depend on vite.
const FRAMEWORKS: readonly { readonly dep: string; readonly kind: string; readonly dev: string }[] = [
    { dep: "astro", kind: "astro", dev: `--port "$PORT" --host --allowed-hosts` },
    { dep: "next", kind: "next", dev: `--port "$PORT" --hostname 0.0.0.0` },
    { dep: "nuxt", kind: "nuxt", dev: `--port "$PORT" --host` },
    { dep: "@sveltejs/kit", kind: "svelte", dev: `--port "$PORT" --host` },
    { dep: "vite", kind: "vite", dev: `--port "$PORT" --host` },
];

const detectFramework = (pkg: AppManifest): (typeof FRAMEWORKS)[number] | undefined => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return FRAMEWORKS.find((framework) => deps[framework.dep] !== undefined);
};

// Discovers every app instance in `_apps/`, in priority order:
// - scaffolded: package.json resolves to a manifest template, which owns the preview spec (one result per preview)
// - convention: any dir with a `dev` script previews via `pnpm --filter <pkg> dev` plus its framework's flags
// Skips a dir with no parseable, named package.json, or no `dev` script.
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
        // A real app instance has a package.json with a name; missing or unparseable disqualifies it as an app.
        let pkg: AppManifest;
        try {
            pkg = JSON.parse(readFileSync(join(appsDir, appName, "package.json"), "utf8")) as AppManifest;
        } catch {
            continue;
        }
        if (pkg.name === undefined) {
            continue;
        }
        const templateKey = resolveTemplate(appName, manifest, pkg);
        const def = templateKey === undefined ? undefined : manifest.templates[templateKey];
        if (def !== undefined) {
            for (const preview of def.previews) {
                result.push({ app: appName, kind: templateKey, pkg: pkg.name, preview });
            }
            continue;
        }
        if (pkg.scripts?.["dev"] === undefined) {
            continue;
        }
        const framework = detectFramework(pkg);
        result.push({
            app: appName,
            kind: framework?.kind,
            pkg: pkg.name,
            preview: { dev: `pnpm --filter {pkg} dev${framework === undefined ? "" : ` ${framework.dev}`}` },
        });
    }
    return result;
};

// Resolves an app's preview into spec fields: dev command ({pkg} → real package name), env ({previewUrl:*}), and
// portEnv.
// portEnv names which env vars mirror the daemon-injected PORT (e.g. the Hono API's API_PORT).
export const buildAppSpec = (opts: {
    repo: string;
    repoDir: string;
    pkg: string;
    app: string;
    preview: AppRun;
    zone: string | undefined;
    sandboxId: string | undefined;
}): { command: string; cwd: string; env: Record<string, string>; portEnv: string[] } => {
    // {pkg} is the app's real package.json name, not the template author's scope, so --filter matches the monorepo.
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
    // `&&` runs dev only after install succeeds; no `exec`, so the shell survives for Ctrl+C and history.
    return { command: `test -d node_modules || pnpm install && ${fill(opts.preview.dev)}`, cwd: opts.repoDir, env, portEnv };
};
