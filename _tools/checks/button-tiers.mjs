#!/usr/bin/env node
// The design system has one action button (Button, four tiers, two sizes) plus five controls deliberately not it
// (iconButton, linkButton, textAction, overlayChip, .ui-chip); nothing else may draw one by hand. A skin restyles real
// Buttons only, so a hand-styled one is inconsistent by construction.
// 1. A bare <button> with a text size, chrome (border/fill) and side padding: that's an action button, use <Button>.
// 2. A hand-written disabled fade (disabled:opacity-*): the one disabled state lives in tokens.css.
// 3. A hardcoded accent (bg-primary-600, text-white) on anything pressable: palette and skins can't reach a literal.
// 4. A <Button> that restates its own tier's geometry (padding, text size, border, fill, radius, weight) in class.
// 5. A <Button> in a row's own control cluster (#control/#actions/#meta/#lead) that isn't size="small".
// 6. A retired spelling: outlined/raised/rounded as props, or severity="warning".
// 7. Two <Button> siblings in one element at different sizes.
// Exceptions: an entry in ALLOWED, keyed by file and exact finding, with a reason; a stale entry is reported.
import { at, blank, classesOf, finishFindings, tags, templateSource, templatesUnder, VOID, waiverList } from "./lib/templates.mjs";

// A text size, not text-left or text-muted: the scale's own steps, what makes a control a button, not a row.
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
// A row's trailing cluster (26px), not what it expands to: an expanded footer is a page's controls, nested.
const ROW_CLUSTER = /(?:#|v-slot:)(?:control|actions|meta|lead)\b/u;

// Waivers keyed by path then exact class/prop, with a reason; only a control's shape, not its tier, qualifies.
const ALLOWED = new Map([
    [
        `_editor/ui/src/components/sandbox/AgentRunButton.vue`,
        new Map([
            [
                `['rounded-l-none', text ? 'pl-1 pr-1.5' : 'px-1.5']`,
                `A SPLIT BUTTON'S SEAM. Two buttons are welded into one control here, so the pair has to lose the corners and the padding where they meet, or it reads as two buttons that happen to be touching. This is the joint, not a tier being retuned: the tier is whatever the caller passed, and both halves take it.`,
            ],
        ]),
    ],
    [
        `_editor/web/src/features/workspace/page/WorkspaceMobile.vue`,
        new Map([
            [
                `h-14 w-14 px-0 py-0 shadow-lg`,
                `THE UPLOAD FAB, and the exception the vocabulary already names (see ui.ts). A floating action button is a 56px circle by definition — the size IS the affordance on a phone — so it is the one control in the app whose box is not a tier's.`,
            ],
            [`rounded`, `The same FAB: a circle is what a floating action button is. Nothing else in the app may take this prop.`],
        ]),
    ],
]);

const tracked = templatesUnder(`_editor`, `_extensions`);
const findings = [];
const { waived, stale } = waiverList(ALLOWED, `button-tiers.mjs`);

for (const path of tracked) {
    const scan = blank(templateSource(path));
    const stack = [{ name: `#file`, attrs: ``, buttons: [] }];
    const inDense = () => stack.some((frame) => DENSE.has(frame.name)) && stack.some((frame) => frame.cluster);

    // Runs on close, once a frame's children are all known: direct Button siblings at different sizes are a visible
    // mismatch; ui-button-loud is exempt since being bigger is its rank, not a size choice.
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

    // A `template v-if`/`v-for` draws nothing, so its buttons fold up as the parent's siblings; a named slot is
    // somebody else's surface and is checked as its own.
    const unwind = (open) => {
        const frame = stack[open];
        if (frame.name === `template` && !/(?:^|\s)(?:#|v-slot)/u.test(frame.attrs)) {
            stack[open - 1].buttons.push(...frame.buttons);
        } else {
            closed(frame);
        }
        stack.length = open;
    };

    for (const { closing, name, attrs, selfClosing, index } of tags(scan)) {
        if (closing !== ``) {
            const open = stack.findLastIndex((frame) => frame.name === name);
            if (open > 0) {
                unwind(open);
            }
            continue;
        }
        const where = at(path, scan, index);
        const classes = classesOf(attrs);
        const pressable = name === `button` || name === `Button`;

        // Rule 1: text-left exempts a row's own label alignment from being read as a button's centred one.
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

        // Rule 7: a rounded-full box with padding is a pill regardless of how it was built; the chip owns that shape.
        if (name === `button` && PILL.test(classes) && PAD_X.test(classes) && !RECIPES.test(classes) && !waived(path, classes)) {
            findings.push({
                at: where,
                why: `a hand-drawn pill: use \`class="ui-chip"\` (plus \`ui-chip-on\` for the lit state), which owns the radius, the tone, the hover, the thumb target and what ON looks like`,
            });
        }

        // Rule 8: a square box with no text and no resting chrome is an icon ghost; iconButton bakes in the tap target.
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

        // Rule 2: a hand-written disabled fade, a second opinion on what tokens.css already answers.
        const fade = classes.match(/(?:^|\s)!?disabled:opacity-\d+/u);
        if (fade !== null && !waived(path, fade[0].trim())) {
            findings.push({
                at: where,
                why: `\`${fade[0].trim()}\` is a hand-written disabled state: the design system has exactly one, it is not an opacity (a 0.6 fade of a 10% tint is a 6% tint, i.e. nothing), and it is \`--ui-button-off-*\` in tokens.css`,
            });
        }

        // Rule 3: a literal accent color the palette picker and the skin cannot repaint.
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

            // Rule 4: a call site restating geometry the tier already owns.
            if (classes !== `` && TIER_GEOMETRY.test(classes) && !waived(path, classes)) {
                findings.push({
                    at: where,
                    why: `<Button class="${classes.trim()}"> restates geometry the tier owns: pick the tier and the size instead, and keep only layout here (shrink-0, w-full, self-start, margins)`,
                });
            }

            // Rule 5: a row's own control cluster needs the compact size.
            if (inDense() && !/(?:^|\s):?size=/u.test(attrs) && !waived(path, `size`)) {
                findings.push({
                    at: where,
                    why: `<Button> in a row's own control cluster takes the compact control: add \`size="small"\`, which is what every other row action in the app is drawn at`,
                });
            }

            // Rule 6: a spelling the design system retired.
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

findings.push(...stale());

finishFindings(
    findings,
    `with button tiers. The app has one action button: <Button>, in four tiers and two sizes.`,
    `${tracked.length} templates: every button is <Button>, every tier is a rank, and "not right now" has one answer`,
);
