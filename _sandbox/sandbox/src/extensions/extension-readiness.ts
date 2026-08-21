import { access } from "node:fs/promises";
import { join } from "node:path";
import { extensionApiVersion } from "@intentic/extension-api/protocol";
import { bundleProblem, bundleSpecifiers, type ExtensionManifest } from "@intentic/extension-manifest";
import { extensionRead } from "../capabilities/extension-dirs.js";
import type { InstalledExtension } from "./installed-extensions.js";

/* IS THIS EXTENSION FIT TO PUBLISH, the checks that can be answered from the files alone, and the reason they
 * are worth answering before anybody else runs them.
 *
 * All four failures below are SILENT in the workspace and fatal once published, which is the whole argument for
 * a check: the author's own copy is loaded from a directory the daemon reads live, so a bundle that only works
 * because of how it is being loaded here looks perfect right up until it is a sha in someone else's sandbox.
 * These are the things a human had to verify by hand for the first four extensions ever published from here, and
 * a hand check that has to be repeated is a check that will eventually be skipped.
 *
 * DELIBERATELY NOT AN AGENT. Every question here has one right answer readable off the bytes, whether a file
 * exists, what a line imports, whether two version strings match. Handing that to a model would make a slower,
 * dearer, less certain version of a function, and would put a judgement call where there is none. The judgement
 * lives one layer up, in what an author does about a warning. */

export type ReadinessStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
    readonly id: string;
    // What was checked, in the author's terms rather than the implementation's.
    readonly label: string;
    readonly status: ReadinessStatus;
    // What was found. Always populated for warn/fail, a status with no stated reason is an opinion.
    readonly detail: string;
}

const exists = async (path: string): Promise<boolean> =>
    access(path)
        .then(() => true)
        .catch(() => false);

// Everything the manifest promises is on disk, gathered as (what it is → where it says it is) so a failure can
// name both. A missing one is fatal at a different moment for each: the entry at activation, the bin at the
// agent's next turn, the fragment at the next image build, all of them long after publication.
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

/* THE SENTENCE EVERY SURFACE SAYS when an extension's manifest is here and its code is not. Kept in one place
 * because it is said in four (the connector card's status, the add that can't write a skill, the process route,
 * the check below) and four wordings of one fact is four chances to describe a different situation.
 *
 * Deliberately free of the word "rebuild": the trees behind these manifests arrive as a publish-time build
 * context, so the environment overlay, which is what "rebuild" means to this app, and what the web sends a
 * rebuild-worded status to, cannot install them. The only move is a sandbox on the standard image. */
export const RUNTIME_ABSENT_DETAIL = "not included in this image: ships with the standard sandbox image";

/* IS THE EXTENSION'S CODE IN THIS IMAGE AT ALL, the same promised-paths question pathsCheck asks before
 * publication, asked at runtime, because the image split can now answer it "no" for an extension nobody has
 * done anything wrong to. The core image bakes the messaging extensions' MANIFESTS so their connector cards
 * exist in every image; the gateway trees behind them are the standard image's bake-only `messaging` pack.
 *
 * BAKED ONLY, and that restriction is the point. A git-installed checkout and a workspace directory hold files
 * the owner or the author put there, so a missing one is a rotted install or work in progress, pathsCheck
 * already reports that in their terms, and an author mid-build should still watch their own gateway try to
 * start and fail rather than be silently refused. Only an image-baked extension can be complete, correct and
 * still absent.
 *
 * The DECLARED files rather than the built ones, though a gateway's absent dist/ is the visible symptom: a pack
 * copies an extension's whole tree or none of it, so the tracked files answer the same question, and they
 * answer it the same way every time. Probing a build output would make a spawn gate that says yes or no
 * depending on whether anybody had run a build, the one thing a gate must never do. */
export const extensionRuntimeAbsent = async (extension: InstalledExtension): Promise<boolean> => {
    if (extension.source !== "builtin") {
        return false;
    }
    for (const { path } of promisedPaths(extension.manifest)) {
        if (!(await exists(join(extension.dir, path)))) {
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
    /* The rule itself lives in @intentic/extension-manifest (bundleProblem) because a second judge applies it
     * too: the registry scanner re-derives this exact answer cold, at each listed entry's pinned sha, every
     * night. Two hand-rolled copies would drift the way the manifest schema and its published copy once did. */
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
        if (!(await exists(join(extension.dir, path)))) {
            missing.push(`${what} (${path})`);
        }
    }
    if (missing.length > 0) {
        /* An image-baked extension is missing files because the IMAGE does not carry them, not because anyone
         * forgot one, and there is nothing whoever is reading this can add. A warning rather than a failure for
         * the same reason: the extension is fit to publish, it is simply not runnable HERE. */
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
    // Fatal rather than a warning: an extension whose range excludes the host it is published from will be
    // reported incompatible by every app that installs it, which is a listing nobody can use.
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
        // Not a failure, and specifically not a pass either: an unexercised extension is the case where this
        // check has nothing to say, and saying "fine" would be the check lying at the exact moment it matters.
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
