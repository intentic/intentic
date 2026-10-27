// Which packages a scoped emit-declarations run builds: `emit-declarations.mjs [<package>...]` names each by its
// directory (`_tools/base`, or a path to it) or its name (`@intentic/base`). No name is every package. `reads` adds what
// the chosen ones read by manifest, which is what decides the generators that must run before `tsc -b` can.
import { resolve } from "node:path";
import { dependencyClosure } from "./dist-staleness.mjs";
import { root } from "../../checks/lib/repo.mjs";

/** `{ selected, reads }` for `asked` among `all` (repo.mjs `packages` entries), or `{ unknown }` naming what matched none. */
export const scopedPackages = (all, asked, { cwd = process.cwd(), base = root } = {}) => {
    if (asked.length === 0) {
        return { selected: all, reads: all };
    }
    const named = (arg) => all.find(({ dir, pkg }) => arg === pkg.name || resolve(base, arg) === dir || resolve(cwd, arg) === dir);
    const unknown = asked.filter((arg) => named(arg) === undefined);
    if (unknown.length > 0) {
        return { unknown };
    }
    const selected = [...new Set(asked.map(named))];
    const reads = new Set(selected.flatMap((entry) => dependencyClosure(entry, all)));
    return { selected, reads: all.filter((entry) => reads.has(entry)) };
};
