import { join } from "node:path";
import { DEFAULT_TEMPLATE_REF, DEFAULT_TEMPLATE_SOURCE, fetchTemplateManifest, type TemplateManifest } from "@intentic/scaffold";
import type { TemplateSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

export interface TemplatesConfig {
    readonly source: string;
    readonly ref: string;
}

// The per-workspace override for the opinionated-template source, at <root>/.intentic/templates.json. Absent (the
// common case) → the baked-in canonical default. Malformed JSON propagates so a broken override surfaces rather
// than silently reverting to the default.
export const readTemplatesConfig = async (services: Services): Promise<TemplatesConfig> => {
    const raw = await services.files.read(join(services.workspace.root, ".intentic", "templates.json"));
    if (raw === undefined) {
        return { source: DEFAULT_TEMPLATE_SOURCE, ref: DEFAULT_TEMPLATE_REF };
    }
    const parsed = JSON.parse(raw) as { source?: string; ref?: string };
    return { source: parsed.source ?? DEFAULT_TEMPLATE_SOURCE, ref: parsed.ref ?? DEFAULT_TEMPLATE_REF };
};

// Listing means cloning the source to read its manifest, so memoize per source#ref — the "New app" picker hits
// this each open. In-flight promises are shared; a failed clone is evicted so a later retry re-fetches. Cache
// lives for the daemon's lifetime (a restart re-reads); changing the source key naturally fetches fresh.
const manifestCache = new Map<string, Promise<TemplateManifest>>();

// The configured source's full template manifest (shell/shared/templates + per-app previews), memoized per
// source#ref. Both the Add-app picker (listTemplates) and the per-app preview runner (app-previews) read it.
export const loadManifest = async (services: Services): Promise<TemplateManifest> => {
    const { source, ref } = await readTemplatesConfig(services);
    const cacheKey = `${source}#${ref}`;
    let pending = manifestCache.get(cacheKey);
    if (pending === undefined) {
        pending = fetchTemplateManifest(source, ref);
        manifestCache.set(cacheKey, pending);
        pending.catch(() => manifestCache.delete(cacheKey));
    }
    return pending;
};

export const listTemplates = async (services: Services): Promise<TemplateSummary[]> => {
    const manifest = await loadManifest(services);
    return Object.entries(manifest.templates).map(([key, def]) => ({ key, label: def.label, description: def.description }));
};
