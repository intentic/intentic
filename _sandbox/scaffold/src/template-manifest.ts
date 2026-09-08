import { readFileSync } from "node:fs";
import { join } from "node:path";

// Default source, used unless a workspace overrides it in .intentic/config/templates.json.
export const DEFAULT_TEMPLATE_SOURCE = "https://github.com/radarsu/00-canonical-repo";
export const DEFAULT_TEMPLATE_REF = "main";

// A source repo's templates.json: how the monorepo is assembled from a shell, shared packages, and per-template
// instance packages. The daemon lists templates from it; the inject engine scaffolds apps from it.
export interface TemplatePreview {
    // Base package name (no scope, e.g. 'web'); must match one of `instance`'s names, fronted at its own hostname.
    readonly package: string;
    // Dev command for apps.json; `{pkg}` becomes the renamed package name, `{name}` the app name.
    readonly dev: string;
    // Port the dev server listens on; the proxy's forward target, deduped by the daemon.
    readonly port: number;
    // Values may use {name}, {pkg} (engine-filled) and {previewUrl:<package>} for a sibling's URL (daemon-filled).
    readonly env?: Readonly<Record<string, string>>;
}
export interface TemplateDef {
    readonly label: string;
    readonly description: string;
    // Package dirs for one app instance; copied and renamed per add, with cross-references rewritten.
    readonly instance: readonly string[];
    // One entry per previewable dev server; each becomes its own apps.json entry and preview URL.
    readonly previews: readonly TemplatePreview[];
}
export interface TemplateManifest {
    // Package-name scope (e.g. '@app_/'); instance packages rename within it, shared packages keep it untouched.
    readonly scope: string;
    // Root files/dirs copied verbatim when the monorepo is first created (package.json, workspace, turbo...).
    readonly shell: readonly string[];
    // Package dirs injected once with canonical names and reused across every app (tsconfig, ui, ...).
    readonly shared: readonly string[];
    readonly templates: Readonly<Record<string, TemplateDef>>;
}

// `template` is the manifest key (api/web/landing); `name` is the user-chosen instance name, becoming the dir and
// package suffix (e.g. 'shop-api').
export interface AppInstanceInput {
    readonly template: string;
    readonly name: string;
}

// True for `_apps/*` (per-instance, renamed); everything else is shared infra, kept at its canonical name.
export const isAppDir = (dir: string): boolean => dir.startsWith("_apps/");

// Parses a source repo's templates.json; errors (missing file, bad JSON) propagate.
export const readTemplateManifest = (sourceDir: string): TemplateManifest => {
    const manifest = JSON.parse(readFileSync(join(sourceDir, "templates.json"), "utf8")) as TemplateManifest;
    if (typeof manifest.scope !== "string" || typeof manifest.templates !== "object") {
        throw new Error(`${join(sourceDir, "templates.json")} is not a valid template manifest (missing scope/templates)`);
    }
    return manifest;
};
