// THE ONE STORE A PUSH AND A LAND CHECK LEAVE IN A REPOSITORY'S GIT COMMON DIR (`intentic-push-report.json`), shared by
// every worktree: what each push found and let through and each recheck measured (verify/push-report.mjs), and the
// verdict each measured tree got (lib/tree-verdict.mjs: `pnpm verify` after a land, a push check, a refusal). Once two
// files (`intentic-push-verified` held the verdicts), which the push read twice and the sandbox read half of. A JSON
// array, newest first; each entry carries its `kind`. The sandbox files the `push` and `recheck` entries and reads past
// the rest.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";

export const STORE_FILE = "intentic-push-report.json";
// The verdicts' own file before they moved here: read for what it still holds, never written.
export const LEGACY_VERDICT_FILE = "intentic-push-verified";
// Enough push and recheck entries for the pushes between two times the sandbox reads the file, minutes apart.
export const REPORTS_KEPT = 10;
// A day of lands, each writing one `verify` verdict green or red, plus the pushes between them.
export const VERDICTS_KEPT = 40;

const commonDir = (root) => git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();

export const storePath = (root) => {
    const dir = commonDir(root);
    return dir === undefined ? undefined : join(dir, STORE_FILE);
};

export const legacyVerdictPath = (root) => {
    const dir = commonDir(root);
    return dir === undefined ? undefined : join(dir, LEGACY_VERDICT_FILE);
};

// The objects of a JSON array on file, or none: absent, or a file this cannot parse, which the sandbox cannot either, so
// its entries are lost to both already, and starting the file over is what lets the next write be read at all.
export const readArray = (path) => {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // allow(silent-catch): an unreadable store starts over, see above
        return [];
    }
    // A JSON object's constructor is Object, which no array, string, number or null has.
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.constructor === Object) : [];
};

// Every entry on file, newest first; none when git cannot name the common dir.
export const readStore = (root) => {
    const path = storePath(root);
    return path === undefined ? [] : readArray(path);
};

const isVerdict = (entry) => entry.kind === "verdict";

// The newest REPORTS_KEPT reports and VERDICTS_KEPT verdicts, in their order.
const trimmed = (entries) => {
    let reports = 0;
    let verdicts = 0;
    return entries.filter((entry) => (isVerdict(entry) ? ++verdicts <= VERDICTS_KEPT : ++reports <= REPORTS_KEPT));
};

/**
 * Puts `entry` first, less any entry `replaces` names, and keeps what is kept of each kind. Never throws: `{ ok: true,
 * path }` or `{ ok: false, why }`, since every caller is a push or a check that goes either way and must not be stopped
 * by its own bookkeeping.
 */
export const writeStore = (root, entry, replaces = () => false) => {
    const path = storePath(root);
    if (path === undefined) {
        return { ok: false, why: "git could not name this repository's common dir" };
    }
    // Written aside and renamed over, so a reader never sees half a file; the pid keeps two writers' scratch files apart.
    const scratch = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(scratch, `${JSON.stringify(trimmed([entry, ...readArray(path).filter((each) => !replaces(each))]))}\n`);
        renameSync(scratch, path);
        return { ok: true, path };
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        try {
            rmSync(scratch, { force: true });
        } catch (cleanup) {
            return { ok: false, why: `${why} (and ${scratch} is left behind: ${cleanup instanceof Error ? cleanup.message : String(cleanup)})` };
        }
        return { ok: false, why };
    }
};
