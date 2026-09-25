import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLinkedWorktree, root, subjectScope } from "./repo.mjs";

/* A RATCHET READS ITS BASELINE AND NEVER WRITES IT DURING A CHECK. Three explicit commands write one, each naming what
   earned the move:
   - `--tighten a,b,c` lowers the entries those paths touch to what the tree holds. The check after a land runs it with
     the land's own paths (verify.mjs, fixers.mjs), so a lower count is written by the land that earned it and by
     nothing else; a whole-tree check run only says the tree beats the baseline.
   - `--write-baseline --reason "<why>"` adopts the whole tree's findings, in the primary checkout only.
   - `layout.mjs --allow <dir> --reason "<why>"` records one key (`allowOne`).
   Growth is always declared: an entry raised by adoption or `--allow` carries its reason in the baseline. */

const argAfter = (flag) => {
    const at = process.argv.indexOf(flag);
    return at === -1 ? undefined : (process.argv[at + 1] ?? "");
};

// `--write-baseline` adopts the whole tree's findings; a caller exits 0 once every ratchet it runs has written.
export const ADOPTING = process.argv.includes("--write-baseline");

// The reason a deliberate growth is recorded with; required by every command that raises an entry.
const reasonGiven = () => {
    const reason = argAfter("--reason")?.trim();
    return reason === undefined || reason === "" || reason.startsWith("--") ? undefined : reason;
};

// `--tighten a,b,c`: the repo-relative paths a land changed. Undefined means this is a check run, which writes nothing.
const tightenPaths = () => {
    const listed = argAfter("--tighten");
    if (listed === undefined) {
        return undefined;
    }
    return listed
        .split(",")
        .filter((path) => path !== "" && !path.startsWith("--"))
        .map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));
};

const fileOf = (name) => join(root, "_tools/checks/baselines", `${name}.json`);

const readBaseline = (name) => {
    const path = fileOf(name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
};

const sorted = (entries) => `${JSON.stringify(Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))), null, 4)}\n`;

// An entry's allowance: a count; a reason alone, which allows one; or `{ count, why }`, a count raised on purpose.
export const allowanceOf = (value) => {
    if (value === undefined) {
        return 0;
    }
    if (typeof value === "number") {
        return value;
    }
    return typeof value === "string" ? 1 : value.count;
};

// The entry that allows `count` and keeps what `before` said about why; `reason` is recorded where the entry grows.
const entryOf = (before, count, reason) => {
    const why = typeof before === "string" ? before : typeof before === "object" ? before.why : undefined;
    const stated = count > allowanceOf(before) ? reason : why;
    if (stated === undefined) {
        return count;
    }
    return count === 1 ? stated : { count, why: stated };
};

// A key names a path (a file, a directory, a package); a land touches it when it changed that path or anything under it.
const underKey = (key, path) => path === key || path.startsWith(`${key}/`);

// The baseline with every entry in `scope` the tree has beaten lowered to what it holds, dropped at zero.
export const tightenedOf = (baseline, found, inScope) => {
    const next = { ...baseline };
    const lowered = [];
    for (const [key, value] of Object.entries(baseline)) {
        const now = found.get(key) ?? 0;
        if (now < allowanceOf(value) && inScope(key)) {
            lowered.push(`${key}: ${allowanceOf(value)} → ${now}`);
            if (now === 0) {
                delete next[key];
            } else {
                next[key] = entryOf(value, now, undefined);
            }
        }
    }
    return { next, lowered };
};

// Adoption writes what the tree holds: an entry that grows takes the stated reason, one that did not keeps its own.
export const adoptedOf = (baseline, found, reason) => [...found].map(([key, count]) => [key, entryOf(baseline[key], count, reason)]);

const refuse = (message) => {
    console.error(message);
    process.exit(2);
};

const adopt = (check, name, found) => {
    if (subjectScope() !== undefined) {
        refuse(`${check}: --write-baseline adopts the whole tree's findings, so it cannot run under --paths`);
    }
    // A worktree or CI runner holds somebody's unlanded work, and adopting it would pass that work off as the standing
    // backlog. Growth from a worktree is declared one key at a time, and rides the land that needs it.
    if (isLinkedWorktree() || process.env.CI !== undefined) {
        refuse(`${check}: --write-baseline adopts every finding in the tree, so it runs only in the primary checkout, not in a worktree or on CI`);
    }
    const reason = reasonGiven();
    if (reason === undefined) {
        refuse(`${check}: --write-baseline raises the baseline, so it needs --reason "<why this growth is right>"; the reason is recorded on every entry it raises`);
    }
    const before = readBaseline(name);
    const entries = adoptedOf(before, found, reason);
    writeFileSync(fileOf(name), sorted(entries));
    const raised = entries.filter(([key, value]) => allowanceOf(value) > allowanceOf(before[key])).length;
    console.log(`${check}: baseline ${name}.json adopts ${found.size} entries, ${raised} of them raised because: ${reason}`);
};

const tighten = (check, name, found, paths, touchedBy) => {
    if (subjectScope() !== undefined) {
        refuse(`${check}: --tighten measures the whole tree and lowers what the named paths touch, so it cannot run under --paths`);
    }
    const baseline = readBaseline(name);
    const { next, lowered } = tightenedOf(baseline, found, (key) => paths.some((path) => touchedBy(key, path)));
    if (lowered.length > 0) {
        writeFileSync(fileOf(name), sorted(Object.entries(next)));
        console.log(`${check}: lowered baselines/${name}.json where the named paths beat it (${lowered.join(", ")})`);
    }
};

/**
 * Findings per key in baselines/<name>.json may only shrink: growth is returned for the caller to refuse. A check run
 * writes nothing; where the tree beats the baseline it says so, and `--tighten <paths>` is what lowers it.
 * `touchedBy(key, path)` says whether a change to `path` can move `key`'s count; by default a key names a path.
 */
export const ratchet = (check, name, found, { touchedBy = underKey } = {}) => {
    if (ADOPTING) {
        adopt(check, name, found);
        return { grown: [], baseline: {}, beaten: [] };
    }
    const scope = subjectScope();
    const paths = tightenPaths();
    if (paths !== undefined) {
        tighten(check, name, found, paths, touchedBy);
    }
    const baseline = readBaseline(name);
    const grown = [...found].filter(([key, count]) => count > allowanceOf(baseline[key])).map(([key, count]) => ({ key, count, allowed: allowanceOf(baseline[key]) }));
    // A scoped run knows nothing of the files it skipped, so it speaks only for the keys it read.
    const { lowered: beaten } = tightenedOf(baseline, found, (key) => scope === undefined || scope.has(key));
    if (beaten.length > 0) {
        console.log(`${check}: the tree beats baselines/${name}.json (${beaten.join(", ")}); the check after the land that changed them lowers it (--tighten)`);
    }
    return { grown, baseline, beaten };
};

// Records one key at its current count, with the reason it may grow: the one deliberate growth, in a line a reviewer can
// see. Callable from a worktree, so the entry rides the land whose change needs it.
export const allowOne = (check, name, key, count) => {
    const reason = reasonGiven();
    if (reason === undefined) {
        refuse(`${check}: recording ${key} raises baselines/${name}.json, so it needs --reason "<why this growth is right>"`);
    }
    const baseline = readBaseline(name);
    writeFileSync(fileOf(name), sorted(Object.entries({ ...baseline, [key]: entryOf(baseline[key], count, reason) })));
};
