import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, subjectScope, writesBaselines } from "./repo.mjs";

// `--write-baseline` adopts the whole tree's findings; a caller exits 0 once every ratchet it runs has written.
export const ADOPTING = process.argv.includes("--write-baseline");

const fileOf = (name) => join(root, "_tools/checks/baselines", `${name}.json`);

const sorted = (entries) => `${JSON.stringify(Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))), null, 4)}\n`;

// An entry's allowance: a count, or 1 where the entry records a reason instead.
const allowanceOf = (value) => (value === undefined ? 0 : typeof value === "number" ? value : 1);

// A recorded reason survives adoption; a new entry is adopted at its count.
const adopt = (check, name, found) => {
    if (subjectScope() !== undefined) {
        console.error(`${check}: --write-baseline adopts the whole tree's findings, so it cannot run under --paths`);
        process.exit(2);
    }
    const path = fileOf(name);
    const before = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeFileSync(path, sorted([...found].map(([key, count]) => [key, typeof before[key] === "string" ? before[key] : count])));
    console.log(`${check}: baseline ${name}.json adopts ${found.size} entries`);
};

// The baseline with every entry the tree has beaten lowered to what it holds, dropped at zero; a scoped run lowers only what it read.
const tightenedOf = (baseline, found, scope) => {
    const next = { ...baseline };
    const lowered = [];
    for (const [key, value] of Object.entries(baseline)) {
        const now = found.get(key) ?? 0;
        if (now < allowanceOf(value) && (scope === undefined || scope.has(key))) {
            lowered.push(`${key}: ${allowanceOf(value)} → ${now}`);
            if (now === 0) {
                delete next[key];
            } else {
                next[key] = now;
            }
        }
    }
    return { next, lowered };
};

// Findings per key in baselines/<name>.json may only shrink: growth is returned, a beaten entry is tightened.
export const ratchet = (check, name, found) => {
    if (ADOPTING) {
        adopt(check, name, found);
        return { grown: [], baseline: {} };
    }
    const path = fileOf(name);
    const scope = subjectScope();
    const baseline = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const grown = [...found].filter(([key, count]) => count > allowanceOf(baseline[key])).map(([key, count]) => ({ key, count, allowed: allowanceOf(baseline[key]) }));
    const { next, lowered } = tightenedOf(baseline, found, scope);
    if (lowered.length > 0 && scope === undefined && writesBaselines()) {
        writeFileSync(path, sorted(Object.entries(next)));
        console.log(`${check}: tightened baselines/${name}.json to what the tree has (${lowered.join(", ")}); it rides the next commit`);
    } else if (lowered.length > 0) {
        console.log(`${check}: the tree beats baselines/${name}.json (${lowered.join(", ")}); the checkout that commits tightens it on its next run`);
    }
    return { grown, baseline };
};

// Records one key at its current count: the one deliberate growth, stated in a line a reviewer can see.
export const allowOne = (name, key, count) => {
    const path = fileOf(name);
    const baseline = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeFileSync(path, sorted(Object.entries({ ...baseline, [key]: count })));
};
