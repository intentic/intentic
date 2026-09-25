import { type ExtensionManifest, ExtensionManifestSchema } from "./manifest.js";
import { fillTemplate, walkMeaning } from "./meaning.js";

// What an update asks for, mechanically. Each manifest folds to a set of POWERS, the consequential facts an owner
// approved, under a stable key (compared) with a plain sentence (shown). The diff is set arithmetic over the keys.
// Deliberately excludes plain settings, display marks, category and version; a power's internals moving keeps its key,
// since the sha pin answers that question instead.

export interface PowersDiff {
    // Powers the new manifest declares that the installed one didn't; the reason an update re-asks.
    readonly added: string[];
    readonly removed: string[];
    readonly unchanged: string[];
}

// The fold itself: every power a manifest declares, its stable key to the sentence shown for it. Read off the schema:
// each field that grants a power says so in its `.meta({ power })` (meaning.ts), so a field added to the manifest is
// either declared a power where it is defined or is not one.
export const powersOf = (manifest: ExtensionManifest): Map<string, string> => {
    const powers = new Map<string, string>();
    walkMeaning(ExtensionManifestSchema, manifest, (meaning, context) => {
        if (meaning.power !== undefined) {
            powers.set(fillTemplate(meaning.power.key, context), fillTemplate(meaning.power.sentence, context));
        }
    });
    return powers;
};

// The arithmetic over two folds, for a caller that kept a fold (key to sentence) rather than the manifest it came from.
export const diffPowerMaps = (from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): PowersDiff => {
    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];
    for (const [key, label] of to) {
        (from.has(key) ? unchanged : added).push(label);
    }
    for (const [key, label] of from) {
        if (!to.has(key)) {
            removed.push(label);
        }
    }
    return { added, removed, unchanged };
};

// `before` absent covers a first install: everything the manifest declares is `added`, the same vocabulary the install
// dialog already renders.
export const diffPowers = (before: ExtensionManifest | undefined, after: ExtensionManifest): PowersDiff =>
    diffPowerMaps(before === undefined ? new Map<string, string>() : powersOf(before), powersOf(after));
