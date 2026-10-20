// Shared markup reading for button-tiers, input-tiers and row-tiers: one git listing, blanking pass, tag walk and
// site-comment lookup, so a fix reaches all three gates at once. Works on a bare checkout, no node_modules or parser,
// since checks run before `pnpm install`.
import { readFileSync } from "node:fs";
import { tags } from "../../../_shared/extension-ui/check/scan.mjs";
import { allowedAt } from "./allow.mjs";
import { root, subjectFiles } from "./repo.mjs";

/** Every tracked .vue file under `roots` that this run is asked to judge (`--paths` narrows it; see repo.mjs's scope). */
export const templatesUnder = (...roots) => subjectFiles(...roots).filter((path) => path.endsWith(`.vue`));

/** The source of one listed template. */
export const templateSource = (path) => readFileSync(`${root}/${path}`, `utf8`);

// The pure markup walk lives with the kit (`_shared/extension-ui/check/scan.mjs`), whose published checker judges
// extensions built outside this repository by the same reading; the repository's gates take it from there.

export { at, blank, classesOf, classWordsOf, tags, VOID } from "../../../_shared/extension-ui/check/scan.mjs";

// The index of the tag whose markup holds `offset` in a blanked scan, or undefined when it sits outside every tag.
const tagHolding = (scan, offset) => {
    for (const { index, end } of tags(scan)) {
        if (index > offset) {
            return undefined;
        }
        if (offset < end) {
            return index;
        }
    }
    return undefined;
};

/**
 * Whether an `allow(<check>): <reason>` comment excuses the finding at `offset` of `source` (lib/allow.mjs): above its
 * line, or above the tag whose attributes hold it, since markup has no room for a comment between attributes. `scan` is
 * the blanked markup; without it only the line is read.
 */
export const excusedAt = (source, scan, offset, check) => {
    const lines = source.split(`\n`);
    const lineOf = (index) => source.slice(0, index).split(`\n`).length;
    const tag = scan === undefined ? undefined : tagHolding(scan, offset);
    return allowedAt(lines, lineOf(offset), check) || (tag !== undefined && allowedAt(lines, lineOf(tag), check));
};

/** Every finding as `path:line  why`, sorted by where it is, then the sentence that says what the gate is for. */
export const finishFindings = (findings, summary, vouched) => {
    if (findings.length > 0) {
        for (const { at: where, why } of findings.toSorted((a, b) => a.at.localeCompare(b.at))) {
            console.error(`${where}  ${why}`);
        }
        console.error(`\n${findings.length} problem(s) ${summary}`);
        process.exit(1);
    }
    console.log(vouched);
};
