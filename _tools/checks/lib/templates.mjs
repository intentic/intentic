/* HOW THE TIER GATES READ A .vue FILE, once. button-tiers, input-tiers and row-tiers each ask a different
 * question of the same markup — is this button on the design system, is this field, does this row take its
 * size from its group — and each of them used to carry its own copy of the READING: the same git listing, the
 * same blanking pass, the same tag expression (two of the three said so in a comment, pointing at the other),
 * the same line-number arithmetic and the same waiver bookkeeping.
 *
 * A copy is what stops a fix from reaching the other two. The tag expression is the case in point: it consumes
 * attribute values as units so a `>` inside `:class="{…}"` cannot end a tag early, which is the one way a
 * regex walk of this markup goes wrong — and it is the kind of thing that gets sharpened once, in whichever
 * file the next bug is reported against.
 *
 * Everything here works on a bare checkout: no node_modules, no parser, nothing installed, because the checks
 * run before `pnpm install` in CI's preflight job and from a pre-push hook on a clone that may never have
 * installed. */
import { existsSync, readFileSync } from "node:fs";
import { git, root } from "./repo.mjs";

/** Every tracked .vue file under `roots`. On disk as well as in the index: a deletion left unstaged is still
 *  listed by git and has nothing to read. */
export const templatesUnder = (...roots) =>
    (git("ls-files", "-z", ...roots) ?? "").split(`\0`).filter((path) => path.endsWith(`.vue`) && existsSync(`${root}/${path}`));

/** The source of one listed template. */
export const templateSource = (path) => readFileSync(`${root}/${path}`, `utf8`);

/* THE TEMPLATE, AND ONLY THE TEMPLATE, with everything else BLANKED rather than stripped: every newline is
 * kept, so a line number computed off the result is the line number in the file.
 *
 * Three things go, and each of them produced a finding before it did. The `<script>` block, because this repo's
 * design notes are long block comments full of markup — "`<SkillRow>` opens an editable skill" in a paragraph is
 * not a usage, and reported as one it sends a reader to a line with no component on it. The `<style>` block, for
 * the same reason in CSS. And the template's own `<!-- -->` notes, which are where every argument in these files
 * actually lives and are thick with example tags. */
const blanked = (m) => m.replace(/[^\n]/gu, ` `);
export const blank = (source) =>
    source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, blanked)
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, blanked)
        .replace(/<!--[\s\S]*?-->/gu, blanked);

/* A tag walk, not a parser. Attribute values are consumed as units so a `>` inside `:class="{…}"`, `:style="{…}"`
 * or a template literal cannot end a tag early, which is the one way a regex walk of this markup goes wrong.
 *
 * Handed out as a GENERATOR rather than as the expression, because a `/g` regex carries `lastIndex` and three
 * gates sharing one object would share that cursor. Each walk gets its own. */
const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|`[^`]*`|[^>"'`])*?)(\/?)>/gu;
export function* tags(scan, from = 0) {
    const walk = new RegExp(TAG.source, TAG.flags);
    walk.lastIndex = from;
    let match;
    while ((match = walk.exec(scan)) !== null) {
        const [, closing, name, attrs, selfClosing] = match;
        yield { closing, name, attrs, selfClosing, index: match.index };
    }
}

/** Elements with no closing tag, so a tag walk must not push them onto its stack. */
export const VOID = new Set([`br`, `hr`, `img`, `input`, `source`]);

/** `path:line` for an offset into the blanked scan, which shares the source's newlines. */
export const at = (path, scan, index) => `${path}:${scan.slice(0, index).split(`\n`).length}`;

/** Both `class="…"` and `:class="…"`, joined: geometry hidden in a bound class is the same geometry. */
export const classesOf = (attrs) => [...attrs.matchAll(/:?class="([^"]*)"/gu)].map((m) => m[1]).join(` `);

/* THE SAME CLASSES WITH THE PUNCTUATION TURNED INTO WHITESPACE, and that is not tidying. A bound class is
 * usually an ARRAY of template literals — `:class="[`field-bare …`, readonly ? `caret-transparent` : ``]"` — so
 * the first class in it is preceded by a backtick, not by a space. A rule that anchors on `(?:^|\s)` reads
 * those as classes wearing nothing at all, and reports exactly the call sites that got it right. */
export const classWordsOf = (attrs) =>
    classesOf(attrs)
        .replace(/[`',]/gu, ` `)
        .replace(/\s+/gu, ` `)
        .trim();

/* THE WAIVER LIST, keyed by path then by the exact finding as it appears in the file, carrying the reason it is
 * not the finding it looks like. A hit is recorded so stale entries can be reported: a waiver whose code is
 * gone stops being an exception and becomes a lie about the codebase, so it is a FINDING rather than a warning.
 * The only way a list like this stays honest is if it fails. */
export const waiverList = (allowed, gate) => {
    const used = new Set();
    return {
        waived: (path, key) => {
            if (allowed.get(path)?.get(key) === undefined) {
                return false;
            }
            used.add(JSON.stringify([path, key]));
            return true;
        },
        stale: () =>
            [...allowed].flatMap(([path, entries]) =>
                [...entries.keys()]
                    .filter((key) => !used.has(JSON.stringify([path, key])))
                    .map((key) => ({ at: path, why: `stale ALLOWED entry in ${gate}: nothing in this file matches \`${key}\` any more, so drop it` })),
            ),
    };
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
