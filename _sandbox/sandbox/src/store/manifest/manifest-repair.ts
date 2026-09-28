import { relative } from "node:path";
import { isReportedManifest } from "@intentic/sandbox-contract";

// Registry of what can be repaired about a manifest, keyed by absolute path like manifest-problems.ts; populated when a
// store constructs itself.
// - one registry, not a method per store, so a manifest can't be reportable without being repairable
// - edits run through the store's own write queue, ordering a repair against the daemon's own writes to that file

// Edits the raw JSON, not the parsed value, since the schema has already dropped an unknown key by parse time and a
// parsed edit could remove it but never rename it. Undefined means nothing to change.
export type ManifestEdit = (raw: Record<string, unknown>) => Record<string, unknown> | undefined;
type ManifestEditor = (edit: ManifestEdit) => Promise<boolean>;

// Keyed by absolute path, like manifest-problems.ts; made relative at the boundary where the root is known.
const byPath = new Map<string, ManifestEditor>();

// Called by jsonFile on construction; a rebuilt store replaces its editor instead of stacking one.
export const registerManifestEditor = (path: string, editor: ManifestEditor): void => {
    byPath.set(path, editor);
};

// Why a repair didn't happen, in terms the browser can show (most refusals are ordinary races, not failures); undefined
// means it succeeded. A union, not a boolean, since a repair must always say why it declined.
export type RepairRefusal = "unknown file" | "not repairable" | "unreadable file" | "no such key" | "name taken";

export interface ManifestRepairRequest {
    readonly root: string;
    readonly path: string;
    readonly key: string;
    // Absent removes the key; present renames it. `| undefined` since a spread wire input may pass this explicitly.
    readonly to?: string | undefined;
}

// Removes or renames one top-level key of a reported manifest. Guarded by an exact match against the reported-manifest
// table, so no path traversal is possible; renaming onto an existing key is refused rather than clobbering it.
export const repairManifest = async ({ root, path, key, to }: ManifestRepairRequest): Promise<RepairRefusal | undefined> => {
    if (!isReportedManifest(path)) {
        return "unknown file";
    }
    const editor = [...byPath.entries()].find(([absolute]) => relative(root, absolute).replaceAll("\\", "/") === path)?.[1];
    if (editor === undefined) {
        // Reportable but no store built over it (table, composition disagree); refused, not written around the queue.
        return "not repairable";
    }
    let refusal: RepairRefusal | undefined;
    const wrote = await editor((raw) => {
        if (!Object.hasOwn(raw, key)) {
            // Likely gone already, hand-edited between notice and click; reported, not treated as a successful write.
            refusal = "no such key";
            return undefined;
        }
        if (to !== undefined && Object.hasOwn(raw, to)) {
            refusal = "name taken";
            return undefined;
        }
        // Rebuilt rather than edited in place so a renamed key keeps its original position, not moved to the bottom.
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
    // Unwritten with no refusal means the edit never ran: the file wasn't valid JSON, so the downgrades rule declines
    // to touch it; still reported, not a silent success.
    return refusal ?? (wrote ? undefined : "unreadable file");
};

// Test seam, matching clearManifestProblems: resets the module-level registry between suites.
export const clearManifestEditors = (): void => byPath.clear();
