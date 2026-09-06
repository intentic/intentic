import { relative } from "node:path";
import { isReportedManifest } from "@intentic/sandbox-contract";

/* THE STRAY KEY, TAKEN OUT BY A BUTTON — the acting half of manifest-problems.ts, and its mirror image.
 *
 * That module is a registry of what the read path FOUND, keyed by absolute path, populated as a side effect of
 * every read. This is a registry of what can be DONE about one of those findings, keyed the same way, populated
 * as a side effect of constructing the store. Two halves of the same idea: the substrate under every manifest
 * knows things no individual store does, so it says them once, here, instead of nineteen times.
 *
 * WHY A REGISTRY AND NOT A METHOD ON THE SETTINGS STORE. Only settings.json can produce a stray key today —
 * personas and capabilities parse as arrays, where `unknownKeyProblems` reports nothing by design — so a
 * `repair` on that one store would work and be smaller. It would also be a repair that silently does not exist
 * for the next object-shaped manifest somebody adds to REPORTED_MANIFEST_PATHS, which is precisely the failure
 * this codebase keeps designing tables to avoid: the notice would offer a button on a row whose file nothing
 * can fix. Opting in by construction means a manifest cannot be reportable and unrepairable at once.
 *
 * WHY IT GOES THROUGH THE STORE'S QUEUE rather than reading and writing the file itself. These are not inert
 * config: settings.json is rewritten in full every time somebody moves a switch on the settings page, and
 * capabilities.json every time a connector changes. A repair that did its own read-modify-write would be the
 * second writer json-file.ts's LOST UPDATES note is about, and the window is not theoretical here — the button
 * is on a screen with those switches. Registering the store's own queued editor is what makes "remove a key"
 * and "save my settings" order themselves instead of racing. */

/* A raw-JSON edit of one manifest, run inside that file's write queue. Raw, not parsed, for the one reason the
 * whole feature turns on: the schema has ALREADY dropped the stray key by the time a parsed value exists, so a
 * parsed edit could remove it (by rewriting the file) but could never rename it — the value to carry across is
 * gone. Returning undefined means "nothing to change", and nothing is written.
 *
 * Non-objects never reach it: `jsonFile` hands over only what parsed as a plain object, so an array manifest
 * (personas, capabilities) simply has no repair to offer, which matches it having no stray keys to report. */
export type ManifestEdit = (raw: Record<string, unknown>) => Record<string, unknown> | undefined;
type ManifestEditor = (edit: ManifestEdit) => Promise<boolean>;

// Keyed by ABSOLUTE path, like manifest-problems.ts, because that is what the store holds. Made relative at the
// boundary, where the workspace root is known.
const byPath = new Map<string, ManifestEditor>();

// Called by `jsonFile` on construction. Idempotent per path: a store rebuilt (tests, a second composition)
// replaces its editor rather than accumulating one per instance.
export const registerManifestEditor = (path: string, editor: ManifestEditor): void => {
    byPath.set(path, editor);
};

/* WHY A REPAIR DID NOT HAPPEN, in the caller's terms, or undefined when it did. A string rather than a thrown
 * error because most of these are things the USER's browser can be told: the common ones are ordinary races
 * (somebody already fixed it by hand, somebody renamed it first) and reporting a race as a failure of the
 * system would be a lie about whose fault it is. The route turns them into status codes.
 *
 * REPORTING ONE IS NOT OPTIONAL, which is the whole reason this is a union and not a boolean. A repair that
 * quietly declined and answered "done" would leave a button that visibly does nothing, on the one card in the
 * product whose entire subject is things quietly not working. */
export type RepairRefusal = "unknown file" | "not repairable" | "unreadable file" | "no such key" | "name taken";

export interface ManifestRepairRequest {
    readonly root: string;
    readonly path: string;
    readonly key: string;
    // Absent removes the key; present renames it, carrying the value. Spelled `| undefined` because the caller
    // spreads a wire input straight in, where an optional field arrives as an explicit undefined.
    readonly to?: string | undefined;
}

/* Remove one top-level key from a reported manifest, or rename it, keeping its value.
 *
 * THE GUARD IS THE REPORTED-MANIFEST TABLE, not a path check, and that is worth being explicit about because
 * this route takes a path from a browser. `isReportedManifest` is an exact match against a fixed list of
 * workspace-relative names, so there is no traversal to defend against and no way to name a file the notice
 * could not already have shown. What can be sent is a key, never a value, so the widest possible outcome is
 * removing something the daemon had already declared inert.
 *
 * RENAMING ONTO AN EXISTING KEY IS REFUSED. `{ skils: true, skills: false }` is a file where the guess is
 * wrong, or where somebody has already fixed it and left the old line behind, and both readings end with a
 * setting the user chose being overwritten by one they misspelled. Removing the stray is available and says so
 * plainly; quietly clobbering is not. */
export const repairManifest = async ({ root, path, key, to }: ManifestRepairRequest): Promise<RepairRefusal | undefined> => {
    if (!isReportedManifest(path)) {
        return "unknown file";
    }
    const editor = [...byPath.entries()].find(([absolute]) => relative(root, absolute).replaceAll("\\", "/") === path)?.[1];
    if (editor === undefined) {
        // The file is reportable but nothing has constructed a store over it: a build where the table and the
        // composition disagree. Refused rather than hand-written here, because a repair that bypassed the queue
        // is the one thing this module exists to prevent.
        return "not repairable";
    }
    let refusal: RepairRefusal | undefined;
    const wrote = await editor((raw) => {
        if (!Object.hasOwn(raw, key)) {
            // Already gone: hand-edited between the notice being drawn and the button being pressed. Not an
            // error to a caller who wanted it gone, but the route still says so rather than reporting a write.
            refusal = "no such key";
            return undefined;
        }
        if (to !== undefined && Object.hasOwn(raw, to)) {
            refusal = "name taken";
            return undefined;
        }
        // Rebuilt rather than deleted in place so the renamed key keeps the stray one's POSITION in the file.
        // A settings file somebody hand-edits has an order they put things in, and moving a line to the bottom
        // to fix its spelling is a diff they did not ask for.
        const next: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(raw)) {
            if (name !== key) {
                next[name] = value;
            } else if (to !== undefined) {
                next[to] = value;
            }
        }
        return next;
    });
    /* NOT WRITTEN AND NOTHING REFUSED means the edit never ran: the file could not be read as JSON at all, so
     * there were no keys to look at. Declining to touch it is right (json-file.ts's DOWNGRADES rule — bytes
     * this build could not parse are never rewritten from anything derived), and saying nothing about it is
     * not: the notice would stay up over a button that had already reported success. */
    return refusal ?? (wrote ? undefined : "unreadable file");
};

// Test seam, matching clearManifestProblems: the registry is module-level, so a suite that registers has to be
// able to put it back.
export const clearManifestEditors = (): void => byPath.clear();
