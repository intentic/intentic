#!/usr/bin/env node
// Enforces the app's one field system (`ui-field-box`, in three variants and two sizes): no hand-styled
// `<input>`/`<textarea>`, one focus state (primeng.css), no ring painted outside the border box, and no call site
// restating a framed field's own geometry. Exceptions live in ALLOWED, keyed by file and exact class.
import { at, blank, classWordsOf, finishFindings, tags, templateSource, templatesUnder, waiverList } from "./lib/templates.mjs";

// What counts as what.

/** Design system field classes, spelled as a class or through a `ui.*` recipe. */
const ON_SYSTEM = /(?:^|\s)(?:ui-field-box|ui-field-shell|field-bare)(?:\s|$)|\bui\.input(?:Sm|Inline)?\s*\(/u;
// Variants whose box belongs to the caller; `ui-field-shell` is a frame, not a control.
const CALLER_GEOMETRY = /(?:^|\s)(?:field-bare|ui-field-inline|ui-field-shell)(?:\s|$)|\bui\.inputInline\s*\(/u;
/** An element that IS a field, or is the box drawn around one. Scopes the focus rules off buttons and rows. */
const FIELDISH = /(?:^|\s)(?:ui-field-box|ui-field-shell|ui-field-lit|ui-field-inline|field-bare)(?:\s|$)/u;

/** `type=` values that are a different control entirely, not a text field. */
const NOT_A_FIELD = new Set([`checkbox`, `radio`, `range`, `color`, `file`, `hidden`, `submit`, `reset`, `button`, `image`]);

/** A focus state written at a call site; there is exactly one, and it lives in primeng.css. */
const HAND_FOCUS = /(?:^|\s)!?(?:[\w@-]+:)*focus(?:-visible|-within)?:(?:border-|ring|bg-|shadow-|outline-)[\w./[\]()-]*/u;
/** Focus suppressed with nothing put back. */
const BARE_OUTLINE_NONE = /(?:^|\s)!?(?:[\w@-]+:)*outline-none(?:\s|$)/u;
/** A focus ring drawn outside the border box, not inside it. */
const OUTWARD_RING = /(?:^|\s)!?(?:[\w@-]+:)*(?:ring(?:-[\w./[\]()-]+)?|outline-offset-(?!0(?:\s|$))[\w.[\]-]+)(?:\s|$)/u;
/** Geometry the variant owns. Side padding is excluded: `pl-*` is room for an adornment only the caller sees. */
const FIELD_GEOMETRY =
    /(?:^|\s)!?(?:[\w@-]+:)*!?(?:p[xytb]?-[\w.[\]/]+|h-\d[\w.[\]/]*(?![\w-])|rounded(?:-[\w[\]./]+)?|border(?:-[\w[\]./]+)?|bg-[\w[\]./-]+|text-(?:4xs|3xs|2xs|xs|sm|base|lg|xl)(?![\w-]))(?:\s|$)/u;
/** A type size that is not a step on the scale. */
const ARBITRARY_TEXT = /(?:^|\s)!?(?:[\w@-]+:)*text-\[[^\]]+\]/u;
/** Spellings the design system retired. */
const RETIRED = /(?:^|\s)ui-field-input-error(?:\s|$)/u;

// No tag-stack tracking here: every rule is about one element's own classes, so the walk stays flat.

// Waivers keyed by path, then by the exact class string, with the reason it isn't the finding it looks like.
const ALLOWED = new Map([
    [
        `_editor/ui/src/components/forms/SearchBar.vue`,
        new Map([
            [
                `inputClass`,
                `THE RECIPE IS COMPUTED, not absent: \`inputClass\` is \`field-bare\` plus the right-hand room this bar actually needs, which depends on how many controls it has (none, a clear "x", or the \`Aa\` switch beside it). A gate that reads only the template cannot follow a computed, and the alternative — inlining three padding variants at the call site — is the thing this gate exists to prevent.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/features/settings/SettingsProfile.vue`,
        new Map([
            [
                `h-8`,
                `PINNED TO A HIDDEN SIZER TWIN, the same shape as SandboxOverview's title: the display name and the field that renames it share one grid cell with an invisible <span> carrying the same box, so the field is exactly as wide as the name it replaced and nothing beside it jumps when editing starts.`,
            ],
            [`px-2`, `The same sizer twin: the span it has to match writes this padding out too.`],
            [`text-base`, `The same sizer twin: this is the heading's type size, and the field borrows it so the two boxes measure the same.`],
        ]),
    ],
    [
        `_editor/web/src/features/sandbox/overview/SandboxOverview.vue`,
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

const tracked = templatesUnder(`_editor`, `_extensions`);
const findings = [];
const { waived, stale } = waiverList(ALLOWED, `input-tiers.mjs`);

for (const path of tracked) {
    const scan = blank(templateSource(path));

    for (const { closing, name, attrs, index } of tags(scan)) {
        if (closing === `/`) {
            continue;
        }
        const classes = classWordsOf(attrs);
        const where = at(path, scan, index);

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

        // Remaining rules apply only to fields and the boxes drawn around them, not buttons or rows.
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
        // Reports each offending token separately: waiving one should not require waiving the whole class list.
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

findings.push(...stale());

finishFindings(
    findings,
    `with input tiers. The app has one field: \`ui-field-box\`, in three variants and two sizes, and its focus state never paints outside its own box.`,
    `${tracked.length} templates: every field is on the design system, focus has one answer, and no ring paints outside its box`,
);
