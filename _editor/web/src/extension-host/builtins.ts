import type { ExtensionModule } from "@intentic/extension-api";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { extensionIdOf } from "@intentic/extension-manifest";
import * as acceptance from "@intentic/ext-acceptance";
import * as activity from "@intentic/ext-activity";
import * as approvals from "@intentic/ext-approvals";
import * as apps from "@intentic/ext-repo-apps";
import * as automations from "@intentic/ext-automations";
import * as deployments from "@intentic/ext-deployments";
import * as documentation from "@intentic/ext-documentation";
import * as gitHistory from "@intentic/ext-git-history";
import * as issues from "@intentic/ext-issues";
import * as knowledge from "@intentic/ext-knowledge";
import * as maintenance from "@intentic/ext-maintenance";
import * as pipelines from "@intentic/ext-pipelines";
import * as preview from "@intentic/ext-preview";
import * as viewers from "@intentic/ext-viewers";
import * as workflows from "@intentic/ext-workflows";

// First-party extensions whose code is compiled into this bundle, keyed by the id the daemon lists them under. Each
// activates through the same manifest-gated createExtensionApi path as a git-installed bundle; only its module is
// statically imported here instead of blob-loaded. Their manifests ship baked into the sandbox image, so `GET
// /extensions` lists them alongside daemon-side and git-installed ones with one on/off switch. A builtin can only touch
// the public IntenticApi, never app internals.

// The package namespace of a compiled-in extension: an ExtensionModule that also exports the manifest the daemon lists
// it under. Typed on the array below so a package that stops exporting one fails here.
export type BuiltinModule = ExtensionModule & { readonly manifest: ExtensionManifest };

const modules: readonly BuiltinModule[] = [
    automations,
    approvals,
    knowledge,
    activity,
    pipelines,
    deployments,
    apps,
    acceptance,
    documentation,
    gitHistory,
    issues,
    maintenance,
    preview,
    viewers,
    workflows,
];

export const builtinModules: ReadonlyMap<string, BuiltinModule> = new Map(modules.map((module) => [extensionIdOf(module.manifest), module]));
