import { access } from "node:fs/promises";
import { join } from "node:path";
import { extensionApiVersion } from "@intentic/extension-api";
import { type ExtensionManifest } from "@intentic/extension-manifest";
import { extensionRead } from "../capabilities/extension-dirs.js";

/* IS THIS EXTENSION FIT TO PUBLISH — the checks that can be answered from the files alone, and the reason they
 * are worth answering before anybody else runs them.
 *
 * All four failures below are SILENT in the workspace and fatal once published, which is the whole argument for
 * a check: the author's own copy is loaded from a directory the daemon reads live, so a bundle that only works
 * because of how it is being loaded here looks perfect right up until it is a sha in someone else's sandbox.
 * These are the things a human had to verify by hand for the first four extensions ever published from here, and
 * a hand check that has to be repeated is a check that will eventually be skipped.
 *
 * DELIBERATELY NOT AN AGENT. Every question here has one right answer readable off the bytes — whether a file
 * exists, what a line imports, whether two version strings match. Handing that to a model would make a slower,
 * dearer, less certain version of a function, and would put a judgement call where there is none. The judgement
 * lives one layer up, in what an author does about a warning. */

export type ReadinessStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
    readonly id: string;
    // What was checked, in the author's terms rather than the implementation's.
    readonly label: string;
    readonly status: ReadinessStatus;
    // What was found. Always populated for warn/fail — a status with no stated reason is an opinion.
    readonly detail: string;
}

// What the shell's import map publishes to a bundle (hostModules.ts). An import of anything else resolves to
// nothing at activation, and the extension is dead with a console error nobody reads.
const PUBLISHED_SPECIFIERS = new Set(["vue", "@intentic/extension-api", "@intentic/extension-ui", "@tanstack/vue-query"]);

// Every `import … from "x"` and `export … from "x"` in a module, plus dynamic `import("x")`. A bundle is one
// file, so a regex over its text is the right instrument: there is no module graph to walk.
const specifiersOf = (source: string): string[] => [
    ...[...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1] ?? ""),
    ...[...source.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)].map((match) => match[1] ?? ""),
    ...[...source.matchAll(/(?:^|\n)\s*import\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1] ?? ""),
];

const exists = async (path: string): Promise<boolean> =>
    access(path)
        .then(() => true)
        .catch(() => false);

// Everything the manifest promises is on disk, gathered as (what it is → where it says it is) so a failure can
// name both. A missing one is fatal at a different moment for each: the entry at activation, the bin at the
// agent's next turn, the fragment at the next image build — all of them long after publication.
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

const bundleCheck = async (dir: string, manifest: ExtensionManifest): Promise<ReadinessCheck> => {
    const id = "bundle";
    const label = "The bundle imports only what the host publishes";
    if (manifest.entry === undefined) {
        return { id, label, status: "pass", detail: "No UI bundle — nothing is loaded in the browser." };
    }
    const source = await extensionRead(join(dir, manifest.entry));
    if (source === undefined) {
        return { id, label, status: "fail", detail: `${manifest.entry} could not be read.` };
    }
    const specifiers = [...new Set(specifiersOf(source))];
    /* A relative import is the sharpest edge here. The host fetches the bundle's bytes and imports them from a
     * blob: URL, against which "./chunk.js" resolves to a blob: URL that was never created — so a build that
     * emitted more than one chunk fails at activation with a 404 for a file that exists on disk. */
    const relative = specifiers.filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/"));
    if (relative.length > 0) {
        return {
            id,
            label,
            status: "fail",
            detail: `Imports a second file (${relative.join(", ")}). The bundle is imported from a blob URL, so nothing relative to it can resolve — it has to be one file.`,
        };
    }
    const unpublished = specifiers.filter((specifier) => !PUBLISHED_SPECIFIERS.has(specifier));
    if (unpublished.length > 0) {
        return {
            id,
            label,
            status: "fail",
            detail: `Imports ${unpublished.join(", ")}, which the host does not publish. Bundle it in, or use one of: ${[...PUBLISHED_SPECIFIERS].join(", ")}.`,
        };
    }
    return { id, label, status: "pass", detail: specifiers.length === 0 ? "Imports nothing." : `Imports ${specifiers.join(", ")}.` };
};

const pathsCheck = async (dir: string, manifest: ExtensionManifest): Promise<ReadinessCheck> => {
    const id = "paths";
    const label = "Every file the manifest promises is there";
    const promised = promisedPaths(manifest);
    const missing: string[] = [];
    for (const { what, path } of promised) {
        if (!(await exists(join(dir, path)))) {
            missing.push(`${what} (${path})`);
        }
    }
    if (missing.length > 0) {
        return { id, label, status: "fail", detail: `Missing: ${missing.join(", ")}.` };
    }
    return { id, label, status: "pass", detail: promised.length === 0 ? "It promises no files." : `All ${promised.length} present.` };
};

const enginesCheck = (manifest: ExtensionManifest, satisfies: boolean): ReadinessCheck => ({
    id: "engines",
    label: "It runs on this version of the app",
    status: satisfies ? "pass" : "fail",
    // Fatal rather than a warning: an extension whose range excludes the host it is published from will be
    // reported incompatible by every app that installs it, which is a listing nobody can use.
    detail: satisfies
        ? `Asks for ${manifest.engines.intentic}; this app is ${extensionApiVersion}.`
        : `Asks for ${manifest.engines.intentic}, but this app is ${extensionApiVersion} — it would not activate anywhere it was installed today.`,
});

const permissionsCheck = (manifest: ExtensionManifest, usage: Record<string, { calls: number }> | undefined): ReadinessCheck => {
    const id = "permissions";
    const label = "It asks only for the reach it uses";
    const declared = manifest.permissions?.sandbox ?? [];
    if (declared.length === 0) {
        return { id, label, status: "pass", detail: "It asks for no daemon routes at all." };
    }
    if (usage === undefined) {
        // Not a failure, and specifically not a pass either: an unexercised extension is the case where this
        // check has nothing to say, and saying "fine" would be the check lying at the exact moment it matters.
        return {
            id,
            label,
            status: "warn",
            detail: `Declares ${declared.length}, and none has been observed being called yet — use it, then check again.`,
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
    dir: string,
    manifest: ExtensionManifest,
    satisfiesEngines: boolean,
    usage: Record<string, { calls: number }> | undefined,
): Promise<ReadinessCheck[]> => [
    await bundleCheck(dir, manifest),
    await pathsCheck(dir, manifest),
    enginesCheck(manifest, satisfiesEngines),
    permissionsCheck(manifest, usage),
];
