import { join } from "node:path";
import type { WorkspaceStatePath } from "@intentic/sandbox-contract";

/* THE ONE WAY THE DAEMON NAMES ITS OWN STATE FILES.
 *
 * `WORKSPACE_STATE_FILES` declares what every file under `<workspace>/.intentic/` is for — which views it makes
 * stale, whether an export carries it. That table is only true if the daemon writes the files it names, and
 * until this helper existed nothing checked: the table said `.intentic/settings.json` and composition.ts said
 * `join(root, ".intentic", "settings.json")`, two spellings of one layout with no link between them. A rename on
 * either side left the other declaring a file nobody writes — silently, because the failure is a view that stops
 * refreshing rather than anything that throws.
 *
 * Taking `WorkspaceStatePath` is the whole point: the argument is a literal union of the table's own paths, so a
 * store can only name a file the table declares, and renaming one breaks the build until both move together.
 *
 * `tail` is for the entries that are DIRECTORIES — the table declares the prefix (`.intentic/browser/`) and the
 * caller names what sits under it. It is checked the same way, since the prefix still has to come from the
 * table. Trailing slashes are dropped so the result is the path a store opens, not a directory spelling. */
export const statePath = (root: string, path: WorkspaceStatePath, ...tail: readonly string[]): string => join(root, path.replace(/\/$/, ""), ...tail);
