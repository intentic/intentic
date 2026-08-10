import { relative } from "node:path";
import type { ManifestProblem, ManifestProblemReport } from "@intentic/sandbox-contract";

/* WHAT THE DAEMON COULD NOT READ IN ITS OWN STATE FILES, kept where a browser can ask for it.
 *
 * Every manifest under `<workspace>/.intentic/` is read through a schema and falls back when that schema says
 * no (see json-file.ts). The fallback is right — a daemon must boot with a broken settings file — but until
 * this module existed it was also the END of the story, and each way of being broken failed the same silent
 * way:
 *
 *   • a file that is not valid JSON, or that the schema rejects whole, reads as ALL DEFAULTS. Every toggle the
 *     user set is quietly off, and nothing anywhere says the file was even looked at.
 *   • a MISSPELLED key parses fine. Zod strips what it does not recognise, so `terseOutpt` is dropped on the
 *     way in and the feature simply never turns on — the single hardest of these to diagnose, because the file
 *     looks right and the daemon looks healthy.
 *   • one bad ENTRY in a list is skipped so the rest survive (capabilities, personas). That is the correct
 *     blast radius, and those stores already report it — but only to `logger.warn`, which is to say to nobody
 *     who is looking at the screen where the capability went missing.
 *
 * So the read path records what it found, here, and a route hands it to the browser. Deliberately a REPLACE
 * per file rather than an accumulating log: a manifest's problems are whatever its last read said, so fixing
 * the file on disk and letting anything read it again is what clears the notice. Nothing to expire, nothing to
 * dismiss, no way for a stale complaint to outlive the thing it was complaining about.
 *
 * Module-level, like the daemon's other cross-cutting registries: the reporting side is `jsonFile`, which is
 * constructed per store all over composition.ts and has no service object to hang this on. */

/* The shapes come from the CONTRACT rather than being declared again here. They are wire types — the browser
 * renders them — and a second definition beside the first is how the two end up disagreeing about what a
 * `kind` may be. What each kind means, and what a reader should do about it, is documented there. */
export type { ManifestProblem, ManifestProblemReport };

// Keyed by the file's ABSOLUTE path, because that is what the reporting side (jsonFile) holds. Made relative
// on the way out, where the workspace root is known.
const byPath = new Map<string, readonly ManifestProblem[]>();

/* Called on EVERY read of a manifest, with everything wrong with it — usually nothing. Always calling is what
 * makes the registry self-clearing: a read that finds a healthy file erases the previous read's complaint
 * rather than leaving it to be aged out or explicitly dismissed. */
export const recordManifestProblems = (path: string, problems: readonly ManifestProblem[]): void => {
    if (problems.length === 0) {
        byPath.delete(path);
        return;
    }
    byPath.set(path, problems);
};

// Every manifest currently reporting a problem, sorted by path so the list is stable between polls. Files
// outside the workspace root (the daemon keeps a few under /history) are reported by absolute path rather than
// a `../../` relative one, which would be worse than useless on screen.
export const manifestProblems = (root: string): ManifestProblemReport[] =>
    [...byPath.entries()]
        .map(([path, problems]) => {
            const rel = relative(root, path);
            // Copied, not handed out by reference: this is the registry's own array, and a caller that sorted
            // or spliced the value it got back would be editing what the next reader sees.
            return { path: rel === "" || rel.startsWith("..") ? path : rel, problems: [...problems] };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));

// Test seam: the registry is module-level, so a suite that records has to be able to put it back.
export const clearManifestProblems = (): void => byPath.clear();
