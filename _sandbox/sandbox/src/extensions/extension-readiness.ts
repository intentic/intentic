import { join } from "node:path";
import { pathExists } from "../path-exists.js";
import { extensionApiVersion } from "@intentic/extension-api/protocol";
import { bundleProblem, bundleSpecifiers, type ExtensionManifest } from "@intentic/extension-manifest";
import { extensionRead } from "../capabilities/extension-dirs.js";
import type { InstalledExtension } from "./installed-extensions.js";

// Readiness checks answerable from the extension's files alone, run before publish (failures are silent until then).
// Not model-based: each question has one answer readable off the bytes; the judgement is left to the author.

export type ReadinessStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
    readonly id: string;
    // What was checked, in the author's terms rather than the implementation's.
    readonly label: string;
    readonly status: ReadinessStatus;
    // What was found. Always populated for warn/fail, a status with no stated reason is an opinion.
    readonly detail: string;
}

// Gathers every file the manifest promises (what it is, where it says it is) so a failure can name it specifically.
// Each is fatal at a different later moment: entry at activation, bin at the next turn, fragment at the next build.
const promisedPaths = (manifest: ExtensionManifest): { readonly what: string; readonly path: string }[] => {
    const promised: { what: string; path: string }[] = [];
    const contributes = manifest.contributes;
    if (manifest.entry !== undefined) {
        promised.push({ what: "entry bundle", path: manifest.entry });
    }
    if (contributes?.bin !== undefined) {
        promised.push({ what: "bin directory", path: contributes.bin });
    }
    if (contributes?.agent?.path !== undefined) {
        promised.push({ what: "agent plugin directory", path: contributes.agent.path });
    }
    if (contributes?.environment !== undefined) {
        promised.push({ what: "image fragment", path: contributes.environment.fragment });
    }
    // A capability's `pack` names a baked-in feature, not a file; an unknown name is caught in fragment-sources.ts.
    for (const capability of contributes?.capabilities ?? []) {
        if ("skill" in capability) {
            promised.push({ what: `skill for ${capability.id}`, path: capability.skill });
        }
        if ("fragment" in capability && capability.fragment !== undefined) {
            promised.push({ what: `fragment for ${capability.id}`, path: capability.fragment });
        }
    }
    return promised;
};

// The one message every surface shows for a missing extension code; avoids "rebuild", which cannot install it.
export const RUNTIME_ABSENT_DETAIL = "not included in this image: ships with the standard sandbox image";

// Runtime version of the paths check, scoped to builtin extensions: only those can be complete yet still absent here.
// Checks the declared files, not build output, since a pack copies an extension's whole tree or none of it.
export const extensionRuntimeAbsent = async (extension: InstalledExtension): Promise<boolean> => {
    if (extension.source !== "builtin") {
        return false;
    }
    for (const { path } of promisedPaths(extension.manifest)) {
        if (!(await pathExists(join(extension.dir, path)))) {
            return true;
        }
    }
    return false;
};

const bundleCheck = async (dir: string, manifest: ExtensionManifest): Promise<ReadinessCheck> => {
    const id = "bundle";
    const label = "The bundle imports only what the host publishes";
    if (manifest.entry === undefined) {
        return { id, label, status: "pass", detail: "No UI bundle, nothing is loaded in the browser." };
    }
    const source = await extensionRead(join(dir, manifest.entry));
    if (source === undefined) {
        return { id, label, status: "fail", detail: `${manifest.entry} could not be read.` };
    }
    // Rule lives in @intentic/extension-manifest (bundleProblem), re-derived independently by the registry scanner.
    const problem = bundleProblem(source);
    if (problem !== undefined) {
        return { id, label, status: "fail", detail: `It ${problem}.` };
    }
    const specifiers = bundleSpecifiers(source);
    return { id, label, status: "pass", detail: specifiers.length === 0 ? "Imports nothing." : `Imports ${specifiers.join(", ")}.` };
};

const pathsCheck = async (extension: InstalledExtension): Promise<ReadinessCheck> => {
    const id = "paths";
    const label = "Every file the manifest promises is there";
    const promised = promisedPaths(extension.manifest);
    const missing: string[] = [];
    for (const { what, path } of promised) {
        if (!(await pathExists(join(extension.dir, path)))) {
            missing.push(`${what} (${path})`);
        }
    }
    if (missing.length > 0) {
        // A builtin extension's missing files mean the image doesn't carry them, not a broken publish; warn, not fail.
        if (extension.source === "builtin") {
            return { id, label, status: "warn", detail: `This extension's code is ${RUNTIME_ABSENT_DETAIL}.` };
        }
        return { id, label, status: "fail", detail: `Missing: ${missing.join(", ")}.` };
    }
    return { id, label, status: "pass", detail: promised.length === 0 ? "It promises no files." : `All ${promised.length} present.` };
};

const enginesCheck = (manifest: ExtensionManifest, satisfies: boolean): ReadinessCheck => ({
    id: "engines",
    label: "It runs on this version of the app",
    status: satisfies ? "pass" : "fail",
    // Fatal, not a warning: excluding the range's own publishing host reports incompatible everywhere it installs.
    detail: satisfies
        ? `Asks for ${manifest.engines.intentic}; this app is ${extensionApiVersion}.`
        : `Asks for ${manifest.engines.intentic}, but this app is ${extensionApiVersion}, it would not activate anywhere it was installed today.`,
});

const permissionsCheck = (manifest: ExtensionManifest, usage: Record<string, { calls: number }> | undefined): ReadinessCheck => {
    const id = "permissions";
    const label = "It asks only for the reach it uses";
    const declared = manifest.permissions?.sandbox ?? [];
    if (declared.length === 0) {
        return { id, label, status: "pass", detail: "It asks for no daemon routes at all." };
    }
    if (usage === undefined) {
        // Neither pass nor fail: an unexercised extension gives nothing to say; "fine" would be a lie here.
        return {
            id,
            label,
            status: "warn",
            detail: `Declares ${declared.length}, and none has been observed being called yet, use it, then check again.`,
        };
    }
    const unused = declared.filter((route) => (usage[route]?.calls ?? 0) === 0);
    if (unused.length > 0) {
        return {
            id,
            label,
            status: "warn",
            detail: `${unused.length} of ${declared.length} have never been called: ${unused.join(", ")}. Each is reach every future owner is asked to approve.`,
        };
    }
    return { id, label, status: "pass", detail: `All ${declared.length} have been used.` };
};

export const extensionReadiness = async (
    extension: InstalledExtension,
    satisfiesEngines: boolean,
    usage: Record<string, { calls: number }> | undefined,
): Promise<ReadinessCheck[]> => [
    await bundleCheck(extension.dir, extension.manifest),
    await pathsCheck(extension),
    enginesCheck(extension.manifest, satisfiesEngines),
    permissionsCheck(extension.manifest, usage),
];
