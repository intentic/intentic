import { readFileSync } from "node:fs";
import { join } from "node:path";

// The opinionated template source, used when a workspace hasn't overridden it in .intentic/templates.json.
export const DEFAULT_TEMPLATE_SOURCE = "https://github.com/radarsu/00-canonical-repo";
export const DEFAULT_TEMPLATE_REF = "main";

// The opinionated-template manifest a source repo publishes at its root (templates.json). It declares how one
// pnpm+turbo monorepo is assembled from a shell (root files), shared packages (injected once, canonical names),
// and per-template `instance` packages (copied + renamed per added app). The intentic daemon reads it to list
// templates; the inject engine reads it to scaffold an app. Authored by the template author — see 00-canonical-repo.
export interface TemplatePreview {
    // The instance package (base name, without scope) this preview runs — e.g. "web", "api", "landing". Must
    // match one of `instance`'s package names; the daemon fronts each preview at its own preview hostname.
    readonly package: string;
    // The dev command to register in .intentic/apps.json. `{pkg}` is replaced by this package's RENAMED name
    // (e.g. @app_/shop-web) and `{name}` by the app name — so it's a plain `pnpm --filter {pkg} dev`.
    readonly dev: string;
    // The port the previewable dev server listens on — the proxy's forward target (deduped by the daemon).
    readonly port: number;
    // Extra env for the dev command. Values may use `{name}`, `{pkg}`, and `{previewUrl:<package>}` — the URL of
    // a SIBLING preview (e.g. web's API_URL = {previewUrl:api}). The engine fills {name}/{pkg}; the daemon,
    // which knows the zone, fills {previewUrl:*}.
    readonly env?: Readonly<Record<string, string>>;
}
export interface TemplateDef {
    readonly label: string;
    readonly description: string;
    // Package dirs (relative to the source root) that belong to ONE app instance — copied and renamed with the
    // app's name on every add. Their cross-references (@app_/… names + relative dir paths) are rewritten.
    readonly instance: readonly string[];
    // One entry per previewable dev server (full-stack ⇒ web + api; landing ⇒ landing). Each becomes its own
    // apps.json entry + preview URL.
    readonly previews: readonly TemplatePreview[];
}
export interface TemplateManifest {
    // Package-name scope, e.g. "@app_/". Instance packages are renamed within it; the scope's `@app_/src` export
    // condition and shared packages keep this prefix untouched.
    readonly scope: string;
    // Root files/dirs copied verbatim when the app monorepo is first created (package.json, workspace, turbo…).
    readonly shell: readonly string[];
    // Package dirs injected once with their canonical names and reused across every app (tsconfig, ui, …).
    readonly shared: readonly string[];
    readonly templates: Readonly<Record<string, TemplateDef>>;
}

// An app instance to inject: `template` is the manifest key (api/web/landing), `name` is the user-chosen
// instance name that becomes the dir and package suffix (e.g. "shop-api"). When `name` equals the template
// key the behaviour is identical to the old single-instance path (the dir stays `_platform/api`).
export interface AppInstanceInput {
    readonly template: string;
    readonly name: string;
}

// True for dirs under `_apps/` — these are per-instance and get renamed when the instance name differs from
// the template key. Everything else (e.g. `_platform/api-contract`, `_platform/prisma`) is shared infra that keeps
// its canonical name and is only injected once.
export const isAppDir = (dir: string): boolean => dir.startsWith("_apps/");

// Parse a source repo's templates.json. Errors (missing file, bad JSON) propagate — a source without a valid
// manifest simply can't be used as a template origin.
export const readTemplateManifest = (sourceDir: string): TemplateManifest => {
    const manifest = JSON.parse(readFileSync(join(sourceDir, "templates.json"), "utf8")) as TemplateManifest;
    if (typeof manifest.scope !== "string" || typeof manifest.templates !== "object") {
        throw new Error(`${join(sourceDir, "templates.json")} is not a valid template manifest (missing scope/templates)`);
    }
    return manifest;
};
