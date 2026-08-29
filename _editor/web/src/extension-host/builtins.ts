import type { ExtensionModule } from "@intentic/extension-api";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { extensionIdOf } from "@intentic/extension-manifest";
import * as acceptance from "@intentic/ext-acceptance";
import * as activity from "@intentic/ext-activity";
import * as apps from "@intentic/ext-repo-apps";
import * as automations from "@intentic/ext-automations";
import * as deployments from "@intentic/ext-deployments";
import * as documentation from "@intentic/ext-documentation";
import * as drafts from "@intentic/ext-drafts";
import * as gitHistory from "@intentic/ext-git-history";
import * as knowledge from "@intentic/ext-knowledge";
import * as maintenance from "@intentic/ext-maintenance";
import * as pipelines from "@intentic/ext-pipelines";
import * as preview from "@intentic/ext-preview";
import * as viewers from "@intentic/ext-viewers";
import * as workflows from "@intentic/ext-workflows";

/* The first-party extensions whose CODE is compiled into this bundle, keyed by the id the daemon lists them
 * under. Each is a real in-repo extension package (its own intentic-extension.json + activate) activated
 * through the SAME manifest-gated createExtensionApi path as a git-installed bundle, the only difference is
 * that its module is statically imported here instead of blob-loaded from the daemon.
 *
 * Their MANIFESTS ship baked into the sandbox image (Dockerfile), so `GET /extensions` enumerates them
 * alongside the daemon-side and git-installed ones and the loader's only remaining question per extension is
 * where its code comes from. That is what gives the Extensions tab one complete list with one on/off switch,
 * instead of a view of a single load path. This stays the dogfooding boundary: a builtin can only touch the
 * public IntenticApi, never app internals. */

// The package namespace of a compiled-in extension: an ExtensionModule that also exports the manifest the
// daemon lists it under. Typed on the array below so a package that stops exporting one fails here.
export type BuiltinModule = ExtensionModule & { readonly manifest: ExtensionManifest };

const modules: readonly BuiltinModule[] = [
    automations,
    drafts,
    knowledge,
    activity,
    pipelines,
    deployments,
    apps,
    acceptance,
    documentation,
    gitHistory,
    maintenance,
    preview,
    viewers,
    workflows,
];

export const builtinModules: ReadonlyMap<string, BuiltinModule> = new Map(modules.map((module) => [extensionIdOf(module.manifest), module]));
