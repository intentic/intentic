#!/usr/bin/env node
/* EVERY BUTTON IN THIS APP IS <Button>, AND THIS IS THE GATE THAT KEEPS IT.
 *
 * The design system has one action button in four tiers and two sizes (_editor/ui/src/lib/ui.ts holds the
 * vocabulary and the argument for it), plus five controls that are deliberately NOT it: `ui.iconButton`,
 * `ui.linkButton`, `ui.textAction`, `ui.overlayChip` and `.ui-chip`. Between them there is nothing left for a
 * hand-styled `<button class="…">` to be.
 *
 * WHY A GATE AND NOT A CONVENTION. The audit that produced this counted 369 <Button> against 117 bare
 * <button>s drawing a button by hand — 68 action buttons, 20 pills and 29 icon affordances — between them
 * using four radii, nine padding pairs and six text colours to mean "a button". "Download" was written four
 * times in four files in two
 * recipes; "Abort" twice; the pair "Done: hand back" / "Can't help now" was duplicated verbatim between
 * Browsers.vue and TerminalPanel.vue in a hardcoded `bg-primary-600 text-white` that ignores the palette,
 * light mode and the skin. None of that was anybody being careless. It is what happens when the cheapest
 * way to get a button is to type one.
 *
 * AND THE COST IS NOT MERELY UNTIDY, WHICH IS THE PART WORTH UNDERSTANDING. A skin (skins/README.md) restyles
 * `.p-button`, so it reaches every real <Button> and NONE of the hand-written ones. In Sanctum that means the
 * app's committing button is a pale carved stone plaque and a hand-styled button beside it is a dark box —
 * the same word, in two materials, permanently, with no call site able to see why. A hand-styled button is
 * not inconsistent by accident; it is inconsistent by construction.
 *
 * WHAT THIS REFUSES:
 *
 *   1. A BARE <button> DRAWN AS AN ACTION BUTTON: a text size, plus a fill or an edge, plus side padding.
 *      That triple is exactly "a labelled control with chrome", which is what <Button> is. Rows, tiles, tabs
 *      and list items do not match it — they set `text-left`, not a size — so this catches buttons and leaves
 *      the controls that merely happen to be <button> elements alone.
 *   2. A HAND-WRITTEN DISABLED FADE (`disabled:opacity-*`). There is one disabled answer, it is not an
 *      opacity, and it is in tokens.css. Four different fades were in the tree when this was written (30, 40,
 *      50 and 60 per cent, across 38 call sites), which is four answers to a question nobody asked twice.
 *   3. A HARDCODED SOLID ACCENT on anything pressable: `bg-primary-600`, `text-white`. The palette is a
 *      runtime choice (the accent picker) and the skins repaint it; a literal step opts that element out of
 *      both, and it is invisible until somebody switches theme.
 *   4. A <Button> THAT OVERRIDES ITS OWN TIER — padding, text size, border, fill, radius or weight in a
 *      `class`. The tier IS the geometry; a call site tuning it has decided its button is a special case,
 *      which is how the app got two sizes of paying CTA. Layout classes (`shrink-0`, `w-full`, `self-start`,
 *      margins) are not geometry and are not refused.
 *   5. A <Button> IN A ROW'S OWN CONTROL CLUSTER THAT IS NOT `size="small"`. In a <Row>'s `#control`,
 *      `#actions`, `#meta` or `#lead` the compact control is the only one that fits 26px of room, and this is
 *      the half of "size is the surface's answer" that can be decided from the markup. What a row EXPANDS to
 *      show is deliberately not this — an edit form's footer nested in a list is a page, and gets the page's
 *      size. The other half of the rule — a page or a dialog taking the default — is what is left over.
 *   7. TWO <Button> SIBLINGS IN ONE ELEMENT AT DIFFERENT SIZES. A row of controls is one surface and takes
 *      one size; a 26px control beside a 38px one is what "the buttons are different sizes" looks like when
 *      somebody reports it. Direct siblings only, so a dialog's footer and its body may still differ.
 *   6. A RETIRED SPELLING: `outlined`, `raised`, `rounded` as <Button> props, and `severity="warning"`.
 *      PrimeVue 4 emits `p-button-warn`, so `warning` falls through every exclusion list in primeng.css and
 *      paints in the BRAND colour — which is what happened to the app's one warning button, for as long as
 *      nobody measured it.
 *
 * HOW AN EXCEPTION IS SPELLED: an entry in ALLOWED, keyed by file and by the exact finding, carrying the
 * reason — the same shape as tailwind-bypass.mjs, and for the same reason. Not a per-file waiver, and not a
 * pragma comment, because these sit inside an opening tag where no comment is legal. An entry that no longer
 * matches anything is reported as stale, so the list cannot outlive the code it excuses. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

/* ── WHAT COUNTS AS WHAT ──────────────────────────────────────────────────────────────────────────────────
 * A TEXT SIZE, not `text-left` and not `text-muted`: the scale's own steps. This is the discriminator that
 * separates a button from a row — a row says where its text goes and what colour it is; a button says how big
 * it is, because it is a control with a size rather than a line in a list. */
const TEXT_SIZE = /(?:^|\s)(?:[\w@-]+:)*text-(?:4xs|3xs|2xs|xs|sm|base|lg|xl|2xl|3xl)(?:\s|$)/u;
/** A drawn edge or a fill — the two ways a control gets chrome. `border-none` and `bg-transparent` are removals. */
const CHROME = /(?:^|\s)(?:[\w@-]+:)*(?:border(?:-[a-z]|\b)(?!-none)|bg-(?!transparent\b)[\w[])/u;
/** Side padding: the horizontal room that makes a label sit inside a box rather than on the page. */
const PAD_X = /(?:^|\s)(?:[\w@-]+:)*p[xl]?-(?!0(?:\s|$))[\w.[\]/-]+/u;
/** A pill. The shape is the whole signal — it is what says "one of a set" — so the kit owns it. */
const PILL = /(?:^|\s)(?:[\w@-]+:)*rounded-full(?:\s|$)/u;
/** A square box with something centred in it and no label: an icon affordance, whatever it was typed as. */
const ICON_BOX = /(?:^|\s)(?:[\w@-]+:)*h-\d[\d.]*(?:\s|$)/u;
const ICON_BOX_W = /(?:^|\s)(?:[\w@-]+:)*w-\d[\d.]*(?:\s|$)/u;

/** The kit's own controls. A <button> wearing one of these has already made every decision this gate is about. */
const RECIPES =
    /ui\.(?:iconButton|linkButton|textAction|addTile|emptyState|overlayChip)\s*\(|(?:^|\s)ui-(?:row-select|chip)(?:-[\w-]+)?(?:\s|$)|\bICON_BUTTON\b|\bROW_ACTION\b/u;

/** Retired <Button> props and the severity PrimeVue 4 renamed. */
const RETIRED = /(?:^|\s):?(?:outlined|raised|rounded)(?:=|[\s>])|severity="warning"/u;

/** Geometry a call site must not restate on a <Button>: the tier owns all of it. Layout is not geometry. */
const TIER_GEOMETRY =
    /(?:^|\s)!?(?:[\w@-]+:)*!?(?:p[xytblr]?-\d|h-\d|min-h-\d|text-(?:4xs|3xs|2xs|xs|sm|base|lg|xl)|rounded|border-|bg-|font-(?:medium|semibold|bold)|gap-)/u;

/** The dense surfaces: a list row is 26px of room and the compact control is the one that fits it. */
const DENSE = new Set([`Row`, `RowGroup`, `DisclosureRow`]);
/* A row's TRAILING CLUSTER, which is the part of it that is 26px tall. A row also expands — into a form, an
 * editor, a block of prose — and what a row reveals is a page, not a row: an edit form's Cancel/Save footer and
 * a settings field's Check button are page-level controls that happen to be nested inside a list. Naming the
 * slots is what tells the two apart, and without it this rule reports nine of them and is simply wrong. */
const ROW_CLUSTER = /(?:#|v-slot:)(?:control|actions|meta|lead)\b/u;

/** Elements with no closing tag, so a tag walk must not push them onto the stack. */
const VOID = new Set([`br`, `hr`, `img`, `input`, `source`]);

/* THE WAIVERS. Keyed by path, then by the exact class string or prop as it appears, with the reason it is not
 * the finding it looks like. Two, and both are geometry that belongs to the SHAPE of a control rather than to
 * its tier — which is the only kind of exception this rule has room for. */
const ALLOWED = new Map([
    [
        `_editor/ui/src/components/AgentRunButton.vue`,
        new Map([
            [
                `['rounded-l-none', text ? 'pl-1 pr-1.5' : 'px-1.5']`,
                `A SPLIT BUTTON'S SEAM. Two buttons are welded into one control here, so the pair has to lose the corners and the padding where they meet, or it reads as two buttons that happen to be touching. This is the joint, not a tier being retuned: the tier is whatever the caller passed, and both halves take it.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/pages/workspace/WorkspaceMobile.vue`,
        new Map([
            [
                `h-14 w-14 px-0 py-0 shadow-lg`,
                `THE UPLOAD FAB, and the exception the vocabulary already names (see ui.ts). A floating action button is a 56px circle by definition — the size IS the affordance on a phone — so it is the one control in the app whose box is not a tier's.`,
            ],
            [`rounded`, `The same FAB: a circle is what a floating action button is. Nothing else in the app may take this prop.`],
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
 * template literal cannot end a tag early. Same expression as row-tiers.mjs, and for the same reason. */
const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|`[^`]*`|[^>"'`])*?)(\/?)>/gu;

const findings = [];
const used = new Set();
const at = (path, source, index) => `${path}:${source.slice(0, index).split(`\n`).length}`;
/** Both `class="…"` and `:class="…"`, joined: geometry hidden in a bound class is the same geometry. */
const classesOf = (attrs) => [...attrs.matchAll(/:?class="([^"]*)"/gu)].map((m) => m[1]).join(` `);

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
    const stack = [{ name: `#file`, attrs: ``, buttons: [] }];
    const inDense = () => stack.some((frame) => DENSE.has(frame.name)) && stack.some((frame) => frame.cluster);

    /* ── 9 · TWO BUTTONS SIDE BY SIDE AT DIFFERENT HEIGHTS ────────────────────────────────────────────────
     * Closing an element is where its own children are finally all known, so the sibling check runs there.
     * DIRECT siblings only, and that narrowness is the whole reason the rule is safe: a dialog's footer and
     * its body are two surfaces and may legitimately differ, but a `justify-end` row holding a Cancel and a
     * Save is one row, and a 26px control beside a 38px one in it is the thing a reader actually notices.
     * `ui-button-loud` is exempt — the money tier is a rank, not a size, and being bigger is part of it. */
    const closed = (frame) => {
        const sizes = new Set(frame.buttons.filter((b) => !b.loud && b.size !== `dynamic`).map((b) => b.size));
        if (sizes.size < 2) {
            return;
        }
        for (const button of frame.buttons) {
            findings.push({
                at: button.at,
                why: `<Button> siblings inside one <${frame.name}> disagree about size (${[...sizes].join(` + `)}): a row of controls is one surface, so it takes one size — \`size="small"\` on a dense one, the default on a page or a dialog`,
            });
        }
    };

    /* A <template v-if>/<template v-for> DRAWS NOTHING, so the buttons inside one are the parent's siblings on
     * screen and have to be folded up rather than judged as their own row. A named slot is the opposite: it is
     * somebody else's surface, and gets checked as one. */
    const unwind = (open) => {
        const frame = stack[open];
        if (frame.name === `template` && !/(?:^|\s)(?:#|v-slot)/u.test(frame.attrs)) {
            stack[open - 1].buttons.push(...frame.buttons);
        } else {
            closed(frame);
        }
        stack.length = open;
    };

    let match;
    TAG.lastIndex = 0;
    while ((match = TAG.exec(scan)) !== null) {
        const [, closing, name, attrs, selfClosing] = match;
        if (closing !== ``) {
            const open = stack.findLastIndex((frame) => frame.name === name);
            if (open > 0) {
                unwind(open);
            }
            continue;
        }
        const where = at(path, scan, match.index);
        const classes = classesOf(attrs);
        const pressable = name === `button` || name === `Button`;

        /* ── 1 · a bare <button> drawn as an action button.
         * `text-left` is the exemption, and it is the discriminator that makes this rule safe to run over an
         * app this size: a BUTTON centres its label because the label is the whole object, and a ROW aligns it
         * left because the label is one column of a line. Every menu item, sheet row, picker option and card
         * tile in the tree says `text-left`, and none of them is what <Button> is for — they are <RowGroup>'s
         * problem and `.ui-row-select`'s. Without it this rule reports the mobile menu's six sheet rows and
         * twenty more like them, which is how a check earns the reputation that gets it switched off. */
        if (
            name === `button` &&
            TEXT_SIZE.test(classes) &&
            CHROME.test(classes) &&
            PAD_X.test(classes) &&
            !/(?:^|\s)text-left(?:\s|$)/u.test(classes) &&
            !RECIPES.test(classes)
        ) {
            if (!waived(path, classes)) {
                findings.push({
                    at: where,
                    why: `a bare <button> with a text size, chrome and side padding IS the action button: use <Button> (tier by role, \`size="small"\` on a dense surface), or one of the four controls that are not it — ui.iconButton / ui.linkButton / ui.textAction / .ui-chip`,
                });
            }
        }

        /* ── 7 · a pill drawn by hand. The chip is a control in its own right (.ui-chip, styles/utilities.css)
         * and the shape is the whole of its meaning, so a rounded-full box with padding is one whether or not
         * it was built as one. Twenty-one of these existed in six geometries with four different spellings of
         * "on", two of which said it with a fill and two with a border. */
        if (name === `button` && PILL.test(classes) && PAD_X.test(classes) && !RECIPES.test(classes) && !waived(path, classes)) {
            findings.push({
                at: where,
                why: `a hand-drawn pill: use \`class="ui-chip"\` (plus \`ui-chip-on\` for the lit state), which owns the radius, the tone, the hover, the thumb target and what ON looks like`,
            });
        }

        /* ── 8 · an icon affordance drawn by hand. A square box with something centred in it, no text size and
         * NO CHROME AT REST is `ui.iconButton()` — which, unlike a hand-written one, carries the coarse-pointer
         * target that turns 24px of ink into a 44px tap without moving a pixel on a desktop.
         *
         * The resting-chrome test is what keeps this rule about icon GHOSTS. A square box that draws a border
         * and a fill of its own is a different object every time — an avatar tile you can replace, a floating
         * overlay control, a stage circle on a job graph — and it has no business being told it is a toolbar
         * affordance. `ui.iconButton` is defined by showing nothing until you point at it. */
        if (
            name === `button` &&
            ICON_BOX.test(classes) &&
            ICON_BOX_W.test(classes) &&
            /(?:^|\s)(?:[\w@-]+:)*justify-center(?:\s|$)/u.test(classes) &&
            !TEXT_SIZE.test(classes) &&
            !CHROME.test(classes.replaceAll(/(?:^|\s)[\w@-]+:\S+/gu, ` `)) &&
            !RECIPES.test(classes) &&
            !waived(path, classes)
        ) {
            findings.push({
                at: where,
                why: `a hand-sized icon affordance: use \`ui.iconButton('h-8 w-8')\`, which is the same control with the coarse-pointer tap target baked in — the thing ninety-odd call sites cannot each be trusted to remember`,
            });
        }

        // ── 2 · a second opinion about what "not right now" looks like
        const fade = classes.match(/(?:^|\s)!?disabled:opacity-\d+/u);
        if (fade !== null && !waived(path, fade[0].trim())) {
            findings.push({
                at: where,
                why: `\`${fade[0].trim()}\` is a hand-written disabled state: the design system has exactly one, it is not an opacity (a 0.6 fade of a 10% tint is a 6% tint, i.e. nothing), and it is \`--ui-button-off-*\` in tokens.css`,
            });
        }

        // ── 3 · a colour the accent picker and the skin cannot reach
        const literal = classes.match(/(?:^|\s)!?(?:[\w@-]+:)*(?:bg-primary-\d{2,3}(?![\w/])|text-white\b)/u);
        if (pressable && literal !== null && !waived(path, literal[0].trim())) {
            findings.push({
                at: where,
                why: `\`${literal[0].trim()}\` pins a control to one step of the palette, so the accent picker and the skin cannot repaint it: use the tier (\`<Button>\` / \`class="ui-button-loud"\`) or the fill tokens (\`--color-primary-fill\` / \`--color-fill-content\`)`,
            });
        }

        if (name === `Button`) {
            stack.at(-1).buttons.push({
                at: where,
                size: /size="small"/u.test(attrs) ? `small` : /(?:^|\s):size=/u.test(attrs) ? `dynamic` : `default`,
                loud: /ui-button-loud/u.test(classes),
            });

            // ── 4 · a call site restating the tier's own geometry
            if (classes !== `` && TIER_GEOMETRY.test(classes) && !waived(path, classes)) {
                findings.push({
                    at: where,
                    why: `<Button class="${classes.trim()}"> restates geometry the tier owns: pick the tier and the size instead, and keep only layout here (shrink-0, w-full, self-start, margins)`,
                });
            }

            // ── 5 · the compact control is the one that fits a list row
            if (inDense() && !/(?:^|\s):?size=/u.test(attrs) && !waived(path, `size`)) {
                findings.push({
                    at: where,
                    why: `<Button> in a row's own control cluster takes the compact control: add \`size="small"\`, which is what every other row action in the app is drawn at`,
                });
            }

            // ── 6 · a spelling the design system retired
            const retired = attrs.match(RETIRED);
            if (retired !== null && !waived(path, retired[0].trim())) {
                findings.push({
                    at: where,
                    why: `\`${retired[0].trim()}\` is retired: \`outlined\` was the neutral tier's second spelling (use severity="secondary"), and PrimeVue 4 emits \`warn\` — \`severity="warning"\` matches no rule in primeng.css and paints in the brand colour`,
                });
            }
        }

        if (selfClosing === `` && !VOID.has(name)) {
            stack.push({ name, attrs, cluster: name === `template` && ROW_CLUSTER.test(attrs), buttons: [] });
        }
    }
}

/* A waiver whose code is gone stops being an exception and becomes a lie about the codebase. Reported as a
 * finding rather than a warning, because the only way a list like this stays honest is if it fails. */
for (const [path, entries] of ALLOWED) {
    for (const key of entries.keys()) {
        if (!used.has(JSON.stringify([path, key]))) {
            findings.push({ at: path, why: `stale ALLOWED entry in button-tiers.mjs: nothing in this file matches \`${key}\` any more, so drop it` });
        }
    }
}

if (findings.length > 0) {
    for (const { at: where, why } of findings.toSorted((a, b) => a.at.localeCompare(b.at))) {
        console.error(`${where}  ${why}`);
    }
    console.error(`\n${findings.length} problem(s) with button tiers. The app has one action button: <Button>, in four tiers and two sizes.`);
    process.exit(1);
}

console.log(`${tracked.length} templates: every button is <Button>, every tier is a rank, and "not right now" has one answer`);
