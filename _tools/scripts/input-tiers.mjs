#!/usr/bin/env node
/* EVERY FIELD IN THIS APP IS `ui-field-box`, AND THIS IS THE GATE THAT KEEPS IT.
 *
 * The design system has one field in three variants and two sizes (_editor/ui/src/lib/ui.ts holds the
 * vocabulary, styles/primeng.css holds the rules, docs/input-audit.md holds the sweep). Between the framed box,
 * the chrome-less `field-bare` whose frame belongs to a `ui-field-shell` around it, and the `ui-field-inline`
 * that stands where a line of text stood, there is nothing left for a hand-styled `<input class="…">` to be.
 *
 * WHY A GATE AND NOT A CONVENTION. The audit that produced this counted 128 fields, 46 of them drawn by hand,
 * and the axes did not agree: fourteen answers for height, eleven for type size, five for background, four for
 * radius and four for the rim. The expensive one was focus, at NINE answers — and the one on 90 of the 128,
 * `focus:border-line-strong focus:outline-none`, is byte-identical to the same field's HOVER state while also
 * discarding the browser's own ring. Eight more fields suppressed focus with nothing put back, nineteen had no
 * focus rule at all, and five wore a `ring-1` that was never focus-scoped, so it was lit the whole time the
 * field existed. None of that was anybody being careless. It is what happens when the cheapest way to get a
 * field is to type one.
 *
 * AND, AS WITH THE BUTTONS, THE COST IS NOT MERELY UNTIDY. A skin repaints fields (skins/README.md), and it can
 * only reach the ones it can select. sanctum.css used to ask for them by element and type — text, search, email,
 * password, number — a list that had already lapsed: the app ships `url`, `time` and `datetime-local` too, so
 * four fields sat on a carved-stone surface as flat dark boxes and no call site could see why. A hand-drawn
 * field is not inconsistent by accident; it is inconsistent by construction.
 *
 * WHAT THIS REFUSES:
 *
 *   1. A FIELD THAT IS NOT ON THE DESIGN SYSTEM. An `<input>` or `<textarea>` a person types into, wearing none
 *      of the field classes. Checkboxes, radios, ranges, colour wells and file pickers are different controls
 *      and are not asked; a visually hidden input is not a field on screen and is not asked either.
 *   2. A HAND-WRITTEN FOCUS ANSWER — `focus:border-*`, `focus:ring-*`, `focus:bg-*`, `focus-within:border-*`,
 *      or a bare `outline-none` with nothing put back. There is one focus state, it is in primeng.css, and it
 *      is the axis this whole sweep was about.
 *   3. A FOCUS RING THAT PAINTS OUTSIDE THE BOX — `ring-*`, a positive `outline-offset`, or a focus-scoped
 *      `shadow-*`. THIS IS THE RULE WORTH READING TWICE, because it is invisible until it is somebody else's
 *      screen. An outward ring lands on top of whatever sits a few pixels away in a tight row, and it is CUT
 *      OFF by any ancestor with `overflow: hidden` or `auto` — every scroll pane, rounded card and dialog body
 *      in this app. Both were shipping: five `ring-1`s on inline renames, and a `ring-2` on the chat composer,
 *      which is pinned to the bottom of a scroll pane. A half-drawn focus ring reads as a rendering bug, and
 *      the call site can never see the ancestor that clipped it. Drawn inward it is the same signal, correct in
 *      every container, and it adds no layout size. A resting `shadow-*` is untouched: a drop shadow is a
 *      decoration on a floating surface, not a focus state.
 *   4. A CALL SITE RESTATING THE FIELD'S OWN GEOMETRY — padding, a type size, a radius, a rim or a fill on a
 *      framed field. The variant IS the geometry; a call site tuning it has decided its field is a special
 *      case, which is how one recipe ended up with 33 of its 82 call sites passing a size back in.
 *   5. AN ARBITRARY TYPE SIZE (`text-[0.8125rem]`) on a framed field. The scale has steps, and a value that is
 *      not one of them cannot be promised to an extension (opt-in/extension-surface.css).
 *   6. A RETIRED SPELLING: `ui-field-input-error` (now `ui-field-error-box`, which re-points the focus tokens
 *      instead of winning a `!important` fight over one border), and `ui.input()` carrying geometry.
 *
 * WHAT IT DELIBERATELY DOES NOT ASK. `field-bare` and `ui-field-inline` are exempt from 4 and 5, and that is a
 * decision rather than a gap: what those two replace is not one shape. A bare field's box belongs to the shell
 * around it, and an inline one stands where a tree node, a pill, a whole rail card or a heading beside a hidden
 * sizer twin stood. `ui.addTile()` is the same call one control over, and the note there says why.
 *
 * HOW AN EXCEPTION IS SPELLED: an entry in ALLOWED, keyed by file and by the exact finding, carrying the
 * reason — the same shape as button-tiers.mjs and tailwind-bypass.mjs, and for the same reason. An entry that
 * no longer matches anything is reported as stale, so the list cannot outlive the code it excuses. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "@intentic/constants/node";

const root = repoRoot(import.meta.url);

/* ── WHAT COUNTS AS WHAT ──────────────────────────────────────────────────────────────────────────────────*/

/** The design system's field classes, however they are spelled — as a class, or through the `ui.*` recipe. */
const ON_SYSTEM = /(?:^|\s)(?:ui-field-box|ui-field-shell|field-bare)(?:\s|$)|\bui\.input(?:Sm|Inline)?\s*\(/u;
/* The variants whose box is the caller's, for the reason in the header — plus `ui-field-shell`, which is a
 * FRAME rather than a control: what it contributes is the focus state for an assembly, and its rim, fill,
 * radius and padding are defaults that the thing inside legitimately moves. The chat composer is a rounded-2xl
 * pill on `bg-overlay`; a glob row is a rounded-md box on canvas; a prompt box has no padding at all because
 * the field inside it supplies its own. Rules 2 and 3 still apply to all of them, which is the part that has
 * to be uniform. */
const CALLER_GEOMETRY = /(?:^|\s)(?:field-bare|ui-field-inline|ui-field-shell)(?:\s|$)|\bui\.inputInline\s*\(/u;
/** An element that IS a field, or is the box drawn around one. Scopes the focus rules off buttons and rows. */
const FIELDISH = /(?:^|\s)(?:ui-field-box|ui-field-shell|ui-field-lit|ui-field-inline|field-bare)(?:\s|$)/u;

/** `type=` values that are a different control entirely. A slider and a tick share nothing with a text box. */
const NOT_A_FIELD = new Set([`checkbox`, `radio`, `range`, `color`, `file`, `hidden`, `submit`, `reset`, `button`, `image`]);

/** A focus state written at a call site. There is one, and it is not here. */
const HAND_FOCUS = /(?:^|\s)!?(?:[\w@-]+:)*focus(?:-visible|-within)?:(?:border-|ring|bg-|shadow-|outline-)[\w./[\]()-]*/u;
/** Focus suppressed with nothing put back — the eight fields that had no indicator at all. */
const BARE_OUTLINE_NONE = /(?:^|\s)!?(?:[\w@-]+:)*outline-none(?:\s|$)/u;
/** A ring drawn OUTSIDE the border box. The one rule that is about behaviour rather than looks. */
const OUTWARD_RING = /(?:^|\s)!?(?:[\w@-]+:)*(?:ring(?:-[\w./[\]()-]+)?|outline-offset-(?!0(?:\s|$))[\w.[\]-]+)(?:\s|$)/u;
/** Geometry the variant owns. Side padding is NOT here: `pl-8` is room for an adornment only the caller sees. */
const FIELD_GEOMETRY =
    /(?:^|\s)!?(?:[\w@-]+:)*!?(?:p[xytb]?-[\w.[\]/]+|h-\d[\w.[\]/]*(?![\w-])|rounded(?:-[\w[\]./]+)?|border(?:-[\w[\]./]+)?|bg-[\w[\]./-]+|text-(?:4xs|3xs|2xs|xs|sm|base|lg|xl)(?![\w-]))(?:\s|$)/u;
/** A type size that is not a step on the scale. */
const ARBITRARY_TEXT = /(?:^|\s)!?(?:[\w@-]+:)*text-\[[^\]]+\]/u;
/** Spellings the design system retired. */
const RETIRED = /(?:^|\s)ui-field-input-error(?:\s|$)/u;

/* There is NO TAG STACK here, unlike button-tiers.mjs, and the difference is worth stating: that gate has to
 * know whether a button sits inside a row's control cluster, so it tracks ancestry. Every rule here is about
 * one element's own classes, so the walk is flat and a void element needs no special case. */

/* THE WAIVERS. Keyed by path, then by the exact class string as it appears, with the reason it is not the
 * finding it looks like. Two, and both are a field whose box is pinned to something outside itself. */
const ALLOWED = new Map([
    [
        `_editor/ui/src/components/SearchBar.vue`,
        new Map([
            [
                `inputClass`,
                `THE RECIPE IS COMPUTED, not absent: \`inputClass\` is \`field-bare\` plus the right-hand room this bar actually needs, which depends on how many controls it has (none, a clear "x", or the \`Aa\` switch beside it). A gate that reads only the template cannot follow a computed, and the alternative — inlining three padding variants at the call site — is the thing this gate exists to prevent.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/pages/sandbox/SandboxOverview.vue`,
        new Map([
            [
                `h-8`,
                `PINNED TO A HIDDEN SIZER TWIN. The sandbox title and the field that renames it are stacked in one grid cell, with an invisible <span> carrying the same box so the field is exactly as wide as the text it replaced. Its height, side padding and type are therefore not this field's decision to make — they are the heading's, and the two have to agree to the pixel or the glyphs beside them jump when the mode changes.`,
            ],
            [`px-2`, `The same sizer twin: the span it has to match writes this padding out too.`],
            [`text-lg`, `The same sizer twin: this is the heading's type size, and the field borrows it so the two boxes measure the same.`],
        ]),
    ],
]);

const tracked = execFileSync(`git`, [`ls-files`, `-z`, `_editor`, `_extensions`], {
    cwd: root,
    encoding: `utf8`,
    maxBuffer: 64 * 1024 * 1024,
})
    .split(`\0`)
    .filter((path) => path.endsWith(`.vue`));

/* The template and only the template, BLANKED rather than stripped so a line number computed off the result is
 * the line number in the file. The <script> block goes because this repo's design notes are long comments full
 * of example markup; the <style> block and the template's own <!-- --> notes go for the same reason. */
const blanked = (m) => m.replace(/[^\n]/gu, ` `);
const blank = (source) =>
    source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, blanked)
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, blanked)
        .replace(/<!--[\s\S]*?-->/gu, blanked);

/* A tag walk, not a parser — attribute values are consumed as units so a `>` inside `:class="{…}"` or a
 * template literal cannot end a tag early. Same expression as button-tiers.mjs, and for the same reason. */
const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|`[^`]*`|[^>"'`])*?)(\/?)>/gu;

const findings = [];
const used = new Set();
const at = (path, source, index) => `${path}:${source.slice(0, index).split(`\n`).length}`;
/* Both `class="…"` and `:class="…"`, joined: geometry hidden in a bound class is the same geometry.
 *
 * THE PUNCTUATION BECOMES WHITESPACE, and that is not tidying. A bound class is usually an ARRAY of template
 * literals — `:class="[`field-bare …`, readonly ? `caret-transparent` : ``]"` — so the first class in it is
 * preceded by a backtick, not by a space. Every rule here anchors on `(?:^|\s)`, so without this the two most
 * carefully written fields in the kit (CodeField, ProseField) read as fields wearing nothing at all: the gate
 * would report exactly the call sites that got it right. */
const classesOf = (attrs) =>
    [...attrs.matchAll(/:?class="([^"]*)"/gu)]
        .map((m) => m[1])
        .join(` `)
        .replace(/[`',]/gu, ` `)
        .replace(/\s+/gu, ` `)
        .trim();

/** A waiver hit is recorded so stale entries can be reported; a miss returns false and the finding stands. */
const waived = (path, key) => {
    const reason = ALLOWED.get(path)?.get(key);
    if (reason === undefined) {
        return false;
    }
    used.add(JSON.stringify([path, key]));
    return true;
};

for (const path of tracked) {
    const source = readFileSync(`${root}/${path}`, `utf8`);
    const scan = blank(source);

    TAG.lastIndex = 0;
    let tag;
    while ((tag = TAG.exec(scan)) !== null) {
        const [, closing, name, attrs] = tag;
        if (closing === `/`) {
            continue;
        }
        const classes = classesOf(attrs);
        const where = at(path, scan, tag.index);

        const isNative = name === `input` || name === `textarea`;
        const type = /\btype="([^"]*)"/u.exec(attrs)?.[1] ?? (name === `textarea` ? `textarea` : `text`);
        // A dynamic `:type` is always one of the text kinds here; a hidden or sr-only input is not on screen.
        const typed = isNative && !NOT_A_FIELD.has(type);
        const offscreen = /(?:^|\s)sr-only(?:\s|$)/u.test(classes) || /(?:^|\s)hidden(?:\s|$)/u.test(attrs);
        const isField = typed && !offscreen;

        // ── 1 · a field that never joined the design system
        if (isField && !ON_SYSTEM.test(classes) && !waived(path, classes)) {
            findings.push({
                at: where,
                why: `<${name}> is a field wearing none of the design system's: use \`ui.input()\` / \`ui.inputSm()\` for a framed one, \`ui.inputInline()\` where it replaces a line of text, or \`field-bare\` inside a \`ui-field-shell\` when the box around it draws the frame`,
            });
        }

        // The remaining rules are about fields and the boxes drawn around them, not about buttons or rows.
        if (!isField && !FIELDISH.test(classes)) {
            continue;
        }

        // ── 2 · a focus state written by hand
        const focus = classes.match(HAND_FOCUS);
        if (focus !== null && !waived(path, focus[0].trim())) {
            findings.push({
                at: where,
                why: `\`${focus[0].trim()}\` is a focus state written at a call site: there is one, in primeng.css, and it is the axis this sweep was about — 9 answers across 128 fields, the commonest of them identical to the same field's hover`,
            });
        }

        if (BARE_OUTLINE_NONE.test(classes) && !waived(path, `outline-none`)) {
            findings.push({
                at: where,
                why: `\`outline-none\` throws away the browser's focus ring and puts nothing back: the field classes already replace it with a rim and an inset ring, so this only removes the indicator on the one control that always owes one`,
            });
        }

        // ── 3 · a ring that paints outside the border box
        const outward = classes.match(OUTWARD_RING);
        if (outward !== null && !waived(path, outward[0].trim())) {
            findings.push({
                at: where,
                why: `\`${outward[0].trim()}\` paints outside the border box, so it covers whatever sits beside it in a tight row and is CLIPPED by any ancestor with \`overflow: hidden|auto\` — a scroll pane, a rounded card, a dialog body. A field's focus state is drawn inward (\`--ui-field-focus-inset\`, tokens.css)`,
            });
        }

        // ── 4/5 · geometry and type the variant owns
        /* EVERY offending token, waived one at a time. Reporting only the first would make a field that pins
         * three of them (the sandbox title, below) take three passes to excuse, and each waiver would read as
         * if it were the whole exception. */
        if (!CALLER_GEOMETRY.test(classes)) {
            const geometry = classes
                .split(` `)
                .filter((c) => FIELD_GEOMETRY.test(` ${c} `))
                .filter((c) => !waived(path, c));
            if (geometry.length > 0) {
                findings.push({
                    at: where,
                    why: `\`${geometry.join(` `)}\` restates geometry the field owns: pick the size (\`ui.input()\` at 38px, \`ui.inputSm()\` at 26px) and keep only layout here — a width, \`flex-1\`, \`min-w-0\`, a margin, \`pl-*\` for an icon's room, \`font-mono\`, \`resize-y\``,
                });
            }

            const arbitrary = classes
                .split(` `)
                .filter((c) => ARBITRARY_TEXT.test(` ${c} `))
                .filter((c) => !waived(path, c));
            if (arbitrary.length > 0) {
                findings.push({
                    at: where,
                    why: `\`${arbitrary.join(` `)}\` is a type size off the scale: use a step, which is also the only kind of size that can be promised to an extension bundle`,
                });
            }
        }

        // ── 6 · a spelling the design system retired
        const retired = classes.match(RETIRED);
        if (retired !== null && !waived(path, retired[0].trim())) {
            findings.push({
                at: where,
                why: `\`ui-field-input-error\` is retired: \`ui-field-error-box\` re-points the rim and focus tokens instead of winning an \`!important\` fight over one border, so an invalid field that is also focused shows one state rather than two`,
            });
        }
    }
}

/* A waiver whose code is gone stops being an exception and becomes a lie about the codebase. Reported as a
 * finding rather than a warning, because the only way a list like this stays honest is if it fails. */
for (const [path, entries] of ALLOWED) {
    for (const key of entries.keys()) {
        if (!used.has(JSON.stringify([path, key]))) {
            findings.push({ at: path, why: `stale ALLOWED entry in input-tiers.mjs: nothing in this file matches \`${key}\` any more, so drop it` });
        }
    }
}

if (findings.length > 0) {
    for (const { at: where, why } of findings.toSorted((a, b) => a.at.localeCompare(b.at))) {
        console.error(`${where}  ${why}`);
    }
    console.error(
        `\n${findings.length} problem(s) with input tiers. The app has one field: \`ui-field-box\`, in three variants and two sizes, and its focus state never paints outside its own box.`,
    );
    process.exit(1);
}

console.log(`${tracked.length} templates: every field is on the design system, focus has one answer, and no ring paints outside its box`);
