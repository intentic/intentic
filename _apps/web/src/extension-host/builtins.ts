import type { ExtensionManifest, ExtensionModule } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-api";
import * as acceptance from "@intentic/ext-acceptance";
import * as activity from "@intentic/ext-activity";
import * as apps from "@intentic/ext-repo-apps";
import * as automations from "@intentic/ext-automations";
import * as logs from "@intentic/ext-logs";
import * as memory from "@intentic/ext-memory";
import * as pipelines from "@intentic/ext-pipelines";
import * as preview from "@intentic/ext-preview";
import * as viewers from "@intentic/ext-viewers";

/* The first-party extensions whose CODE is compiled into this bundle, keyed by the id the daemon lists them
 * under. Each is a real in-repo extension package (its own intentic-extension.json + activate) activated
 * through the SAME manifest-gated createExtensionApi path as a git-installed bundle — the only difference is
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

const modules: readonly BuiltinModule[] = [automations, logs, memory, activity, pipelines, apps, acceptance, preview, viewers];

export const builtinModules: ReadonlyMap<string, BuiltinModule> = new Map(modules.map((module) => [extensionIdOf(module.manifest), module]));
