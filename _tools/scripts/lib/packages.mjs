// PUB, read out of packages.sh by the readers that are written in JavaScript rather than bash: the checkout check
// that keeps the list dependency-closed (_tools/checks/publish-set.mjs) and the release guard that asks npm whether
// it has ever heard of these names (release/check-publishable.mjs). Parsing the shell array is what lets the release
// set stay in ONE file while both languages read it — a JS copy of the list would be the drift packages.sh exists to
// prevent. Plain .mjs, no dependencies: its readers run on a bare checkout, before any install.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

export const root = repoRoot(import.meta.url);

// The `PUB=( ... )` array body in packages.sh, continuation backslashes folded, split on whitespace. `undefined` when
// the array is no longer shaped that way, which each caller reports in its own words rather than guessing at a list.
export const publishSet = () => {
    const text = readFileSync(join(root, "_tools/scripts/lib/packages.sh"), "utf8");
    const match = /^PUB=\(([\s\S]*?)\)/m.exec(text);
    if (match === null) {
        return undefined;
    }
    return match[1]
        .replaceAll("\\\n", " ")
        .split(/\s+/)
        .filter((entry) => entry !== "");
};

// A publish-set entry's manifest, by its repo-relative directory.
export const manifestOf = (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
