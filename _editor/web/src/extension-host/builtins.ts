import type { ExtensionModule } from "@intentic/extension-api";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { extensionIdOf } from "@intentic/extension-manifest";
import * as activity from "@intentic/ext-activity";
import * as approvals from "@intentic/ext-approvals";
import * as apps from "@intentic/ext-repo-apps";
import * as automations from "@intentic/ext-automations";
import * as gitHistory from "@intentic/ext-git-history";
import * as pipelines from "@intentic/ext-pipelines";
import * as preview from "@intentic/ext-preview";
import * as projects from "@intentic/ext-projects";
import * as viewers from "@intentic/ext-viewers";
import * as workflows from "@intentic/ext-workflows";

// First-party extensions whose code is compiled into this bundle, keyed by the id the daemon lists them under. Each
// activates through the same manifest-gated createExtensionApi path as a git-installed bundle; only its module is
// statically imported here instead of blob-loaded. Their manifests ship baked into the sandbox image, so `GET
// /extensions` lists them alongside daemon-side and git-installed ones with one on/off switch. A builtin can only touch
// the public IntenticApi, never app internals.
// Only the INCLUDED first-party set: a sandbox is not itself without these. The listed ones (acceptance, documentation,
// maintenance, knowledge, deployments, issues) live in their own repositories and arrive blob-loaded like any install.

// The package namespace of a compiled-in extension: an ExtensionModule that also exports the manifest the daemon lists
// it under. Typed on the array below so a package that stops exporting one fails here.
export type BuiltinModule = ExtensionModule & { readonly manifest: ExtensionManifest };

const modules: readonly BuiltinModule[] = [
    automations,
    approvals,
    activity,
    pipelines,
    apps,
    gitHistory,
    preview,
    projects,
    viewers,
    workflows,
];

export const builtinModules: ReadonlyMap<string, BuiltinModule> = new Map(modules.map((module) => [extensionIdOf(module.manifest), module]));
