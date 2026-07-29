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

// What running one app instance actually takes: the dev command and its env. A structural subset of the
// manifest's TemplatePreview — its `port` is author metadata the daemon never reads (the running port is the
// one the process manager assigns and injects as PORT), so a template preview satisfies this as-is and a
// derived one carries no dead fields.
export type AppRun = Pick<TemplatePreview, "dev" | "env">;

// An app instance present in a monorepo: `app` is the instance name (the `_apps/<app>` dir name, which may
// differ from the template key when the user chose a custom name), `kind` is what sort of app it is — the
// manifest key it was created from (api/web/landing) for a scaffolded instance, else the framework detected
// from its dependencies (astro/next/…), and undefined when neither says — `pkg` is the app package's real
// `name` (read from its package.json — the `pnpm --filter` target, which is scoped to the monorepo's OWN
// scope, not the template's), and `preview` is how to run it.
export interface AppPreview {
    readonly app: string;
    readonly kind: string | undefined;
    readonly pkg: string;
    readonly preview: AppRun;
}

// The app package.json fields discovery reads: the `pnpm --filter` target, the scaffold marker, the `dev`
// script (its presence is what makes a dir startable), and the dependency blocks the framework probe scans.
interface AppManifest {
    readonly name?: string;
    readonly intentic?: { readonly template?: string };
    readonly scripts?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
}

// Resolve the template key a given `_apps/<name>` instance was created from, given its parsed package.json.
// The inject engine stamps `intentic.template` — read it first. Falls back to checking if the dir name is
// itself a template key (pre-marker canonical instances), then a naming-convention heuristic (instance name
// ends with `-<templateKey>`).
const resolveTemplate = (appName: string, manifest: TemplateManifest, pkg: AppManifest): string | undefined => {
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

/* Dev servers that do NOT read the daemon-injected PORT and must be told on the command line, keyed by the
 * dependency that identifies the framework. `dev` is what the manager appends to `pnpm --filter <pkg> dev`
 * (pnpm forwards everything after the script name to the script), so an app whose dev script is a bare
 * `astro dev` still binds the assigned port. `--host`/`--allowed-hosts` are the second half of previewability:
 * the proxy dials 127.0.0.1:PORT but forwards the preview Host unchanged, and a vite-backed server answers an
 * unrecognized Host with 403 "Blocked request" unless told to accept it.
 * Order matters — the more specific framework wins, since astro/nuxt list vite as a dependency of their own. */
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

/* Discover every app instance present in a monorepo's `_apps/` dir. Two shapes, in order:
 *   • Scaffolded — its package.json resolves to a manifest template (api/web/landing). The template owns the
 *     preview spec: the dev command, the port convention, and the sibling `{previewUrl:*}` env wiring. One
 *     result per instance × preview (a template with several previews expands).
 *   • By convention — anything else that declares a `dev` script. A dir under `_apps/` with a dev server IS an
 *     app whatever its provenance, so discovery is not gated on a remote manifest (the same rule panels.ts
 *     applies to repos). Its preview spec is derived from what is on disk: `pnpm --filter <pkg> dev`, plus the
 *     port/host flags its framework needs.
 * A dir with no parseable, named package.json — or one with no `dev` script (a plain library like `_apps/cli`)
 * — is not startable and is skipped; the apps view still surfaces those under Packages via their tests. */
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
    preview: AppRun;
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
    // pane's interactive shell (see managed-processes launch), which must survive the command so Ctrl+C lands at
    // a prompt and ↑ re-runs it.
    return { command: `test -d node_modules || pnpm install && ${fill(opts.preview.dev)}`, cwd: opts.repoDir, env, portEnv };
};
