// Shared markup reading for button-tiers, input-tiers and row-tiers: one git listing, blanking pass, tag walk and
// site-comment lookup, so a fix reaches all three gates at once. Works on a bare checkout, no node_modules or parser,
// since checks run before `pnpm install`.
import { readFileSync } from "node:fs";
import { allowedAt } from "./allow.mjs";
import { root, subjectFiles } from "./repo.mjs";

/** Every tracked .vue file under `roots` that this run is asked to judge (`--paths` narrows it; see repo.mjs's scope). */
export const templatesUnder = (...roots) => subjectFiles(...roots).filter((path) => path.endsWith(`.vue`));

/** The source of one listed template. */
export const templateSource = (path) => readFileSync(`${root}/${path}`, `utf8`);

// Blanks, not strips, `<script>`, `<style>` and `<!-- -->` regions so line numbers stay valid; each one's example
// markup would otherwise misreport as real usage.
const blanked = (m) => m.replace(/[^\n]/gu, ` `);
export const blank = (source) =>
    source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, blanked)
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, blanked)
        .replace(/<!--[\s\S]*?-->/gu, blanked);

// A tag walk, not a parser: attribute values are consumed as units so a `>` inside `:class="{…}"` can't end a tag
// early. A generator, not a shared regex, since `/g` carries `lastIndex` and callers would fight over one cursor.
const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|`[^`]*`|[^>"'`])*?)(\/?)>/gu;
export function* tags(scan, from = 0) {
    const walk = new RegExp(TAG.source, TAG.flags);
    walk.lastIndex = from;
    let match;
    while ((match = walk.exec(scan)) !== null) {
        const [, closing, name, attrs, selfClosing] = match;
        yield { closing, name, attrs, selfClosing, index: match.index, end: walk.lastIndex };
    }
}

/** Elements with no closing tag, so a tag walk must not push them onto its stack. */
export const VOID = new Set([`br`, `hr`, `img`, `input`, `source`]);

/** `path:line` for an offset into the blanked scan, which shares the source's newlines. */
export const at = (path, scan, index) => `${path}:${scan.slice(0, index).split(`\n`).length}`;

/** Both `class="…"` and `:class="…"`, joined: geometry hidden in a bound class is the same geometry. */
export const classesOf = (attrs) => [...attrs.matchAll(/:?class="([^"]*)"/gu)].map((m) => m[1]).join(` `);

// Turns punctuation into whitespace: a bound class is often an array of template literals, so its first class is
// preceded by a backtick, not a space, which a `(?:^|\s)`-anchored rule would otherwise miss.
export const classWordsOf = (attrs) =>
    classesOf(attrs)
        .replace(/[`',]/gu, ` `)
        .replace(/\s+/gu, ` `)
        .trim();

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
