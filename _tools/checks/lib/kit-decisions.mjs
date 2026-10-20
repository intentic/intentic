// THE KIT'S DECIDED LOOKS, read off one template: the rules row-tiers and mark-alignment judge every view by, in one
// place so their tests read the same functions the checks run. Each refuses a decision the owner made once, and had
// re-made view by view while a view could still state it: a header's count, caption, fill or spacing; a card laid in a
// card; rows of different heights; an icon nudged onto its line by a pixel that is right for one type size only.
import { at, classWordsOf, tags, VOID } from "./templates.mjs";

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The look the header owns (`ui.sectionLabel`, drawn only by <SectionHeader>): an uppercase, tracked label.
const HEADER_LOOK = (words) => /(?:^|\s)uppercase(?:\s|$)/u.test(words) && /(?:^|\s)tracking-(?:wide|wider|widest)(?:\s|$)/u.test(words);
const SECTIONS = new Set([`RowGroup`, `Section`]);
// A parent that spaces what it holds: a gap, a vertical rhythm, or hairlines between them.
const SPACED = /(?:^|\s)(?:[\w@-]+:)*(?:gap-(?:y-)?[\d.[]|space-y-|divide-y)/u;
// A height on a row, at any breakpoint.
const ROW_HEIGHT = /(?:^|\s)(?:[\w@-]+:)*(?:min-h|max-h|h)-(?!0(?:\s|$))[\w.[\]/-]+/u;
const ELSE = /(?:^|\s)v-else(?:-if)?(?:[\s=>]|$)/u;

// What each removed header prop was for, said where a call site still passes it.
const RETIRED_PROPS = {
    RowGroup: {
        count: `the rows below are the tally, and a count beside a header is what a dozen views had removed one at a time`,
        caption: `words beside a header were removed view by view as useless; a sentence a reader needs is a <RowNote> on the group's surface`,
        flat: `a group draws no card on a surface (a dialog, a <Card>, another group's card, an overlay) by itself; a label over things that are not rows is a <Section>`,
    },
    NavRail: {
        "sticky-headings": `a pinned header needs a fill to scroll under, and that band is the dark box the documentation rail was fixed for three times`,
        stickyHeadings: `a pinned header needs a fill to scroll under, and that band is the dark box the documentation rail was fixed for three times`,
    },
};

// One walk over a template's open tags, with the stack of elements each sits in: `open` judges a tag (and says whether to
// push it as a frame), `close` judges a frame as it closes, the SFC's own `<template>` included.
const walk = (scan, open, close = () => {}) => {
    const stack = [];
    for (const tag of tags(scan)) {
        if (tag.closing !== ``) {
            const top = stack.findLastIndex((frame) => frame.name === tag.name);
            if (top !== -1) {
                stack.splice(top).forEach(close);
            }
            continue;
        }
        const frame = open(tag, stack);
        if (frame !== undefined && tag.selfClosing === `` && !VOID.has(tag.name)) {
            stack.push(frame);
        }
    }
    stack.splice(0).forEach(close);
};

// `<template v-if>`/`v-for` draw nothing, so what is inside is still its parent's child.
const parentOf = (stack) => stack.findLast((frame) => !frame.transparent);

// ── 4 · a header decision taken at the call site
const retiredProps = (name, attrs) => {
    const retired = RETIRED_PROPS[name] ?? {};
    return [...attrs.matchAll(/(?:^|\s)(?::|v-bind:)?([\w-]+)(?=[\s=>]|$)/gu)]
        .filter((match) => retired[match[1]] !== undefined)
        .map((match) => `<${name}> takes no \`${match[1]}\`: ${retired[match[1]]}`);
};

// ── 7, 8, 10 · a header drawn by hand, a group among another group's rows, a row's own height
const redecidedLooks = (name, words, parent) => [
    ...(/^h[1-6]$/u.test(name) && HEADER_LOOK(words)
        ? [
              `<${name}> is drawn in the section label's look by hand, so its size, spacing and what sits beside it are this view's to drift: use <Section :label> (or <RowGroup :label> over rows), or <SectionHeader :heading> for a header alone`,
          ]
        : []),
    ...(name === `RowGroup` && parent?.name === `RowGroup`
        ? [
              `a <RowGroup> laid straight among another group's rows nests one card in another: put groups side by side in a stack, or the inner one in a <RowNote variant="block"> where it lies on the outer card`,
          ]
        : []),
    ...((name === `Row` || name === `DisclosureRow`) && ROW_HEIGHT.test(words)
        ? [
              `<${name}> is given a height of its own, so it stands taller or shorter than the rows beside it: a row is as tall as its tier, and a settings group whose rows share one height says so once with \`equal-rows\``,
          ]
        : []),
];

// How many sections a tag adds to its parent's stack (rule 9): one drawn several times (`v-for`) counts twice; an `else`
// branch draws instead of its `if`; one that states its own distance from what precedes it (`mt-*`) is spaced already.
const sectionWeight = (name, attrs, words) => {
    if (!SECTIONS.has(name) || ELSE.test(attrs) || /(?:^|\s)m[ty]-(?!0(?:\s|$))/u.test(words)) {
        return 0;
    }
    return /(?:^|\s)v-for=/u.test(attrs) ? 2 : 1;
};

// ── 9 · sections side by side, judged as their parent closes: it states their gap, or it is the template's root
const unspaced = (frame) => {
    if (frame.sections < 2 || (frame.name !== `#root` && SPACED.test(frame.words))) {
        return undefined;
    }
    return frame.name === `#root`
        ? `this template is several <RowGroup>/<Section>s side by side at its root, so whatever mounts it decides whether anything spaces them: wrap them in one box that states the gap (\`flex flex-col gap-6\`)`
        : `<${frame.name}> holds several <RowGroup>/<Section>s and states no gap between them, so their headers touch the section above: give it the stack's gap (\`flex flex-col gap-6\`)`;
};

/**
 * A blanked template's section findings: a header decision taken at the call site (4), a header drawn by hand (7), a
 * group among another group's rows (8), sections side by side with nothing spacing them (9), a row given a height (10).
 */
export const sectionFindings = (path, scan) => {
    const findings = [];
    walk(
        scan,
        ({ name, attrs, index }, stack) => {
            const where = at(path, scan, index);
            // The SFC's own `<template>` is the root every top-level element is a child of.
            if (stack.length === 0 && name === `template`) {
                return { name: `#root`, transparent: false, words: ``, sections: 0, at: where };
            }
            const words = classWordsOf(attrs);
            const parent = parentOf(stack);
            for (const why of [...retiredProps(name, attrs), ...redecidedLooks(name, words, parent)]) {
                findings.push({ at: where, why });
            }
            if (parent !== undefined) {
                parent.sections += sectionWeight(name, attrs, words);
            }
            return { name, transparent: name === `template` && !/(?:^|\s)(?:#|v-slot)/u.test(attrs), words, sections: 0, at: where };
        },
        (frame) => {
            const why = unspaced(frame);
            if (why !== undefined) {
                findings.push({ at: frame.at, why });
            }
        },
    );
    return findings;
};

// ── Glyphs ───────────────────────────────────────────────────────────────────────────────────────────────────────

// A utility that moves a box vertically, at any breakpoint.
const ICON_OFFSET =
    /(?:^|\s)(?:[\w@-]+:)*-?(?:mt|mb|my|translate-y|top)-[\w./[\]-]+|(?:^|\s)(?:[\w@-]+:)*align-(?:top|middle|bottom|text-top|text-bottom|sub|super|baseline|\[[^\]]*\])/u;
const POSITIONED = /(?:^|\s)(?:absolute|fixed)(?:\s|$)/u;
const SIZE = /(?:^|\s)((?:[\w@-]+:)*text-(?:4xs|3xs|2xs|xs|sm|base|lg|xl|2xl|\[[\d.]+rem\]))(?=\s|$)/gu;
const sizesOf = (words) =>
    [...words.matchAll(SIZE)]
        .map((match) => match[1])
        .toSorted()
        .join(` `);

// An `<Icon>` nudged by hand: a vertical utility on it that is not the placement of a positioned box.
const nudgeOf = (words) => (POSITIONED.test(words) ? undefined : ICON_OFFSET.exec(words)?.[0].trim());

// The first words after a glyph leading an `items-start` line, when they state a type size the line does not.
const misreadLine = (line, words) => {
    const stated = sizesOf(words);
    const own = sizesOf(line.words);
    return stated === `` || stated === own
        ? undefined
        : `the words this <Icon> leads state \`${stated}\` and their \`items-start\` line ${own === `` ? `states none` : `states \`${own}\``}: \`.ui-icon\` reads the line's height where its type is stated, so state the size on the line (the words inherit it)`;
};

/**
 * A blanked template's glyph findings: an `<Icon>` nudged by hand, and a glyph-led `items-start` line whose first words
 * state a type size the line does not (`.ui-icon` reads the line's height where its type is stated).
 */
export const glyphFindings = (path, scan) => {
    const findings = [];
    walk(scan, ({ name, attrs, index }, stack) => {
        const words = classWordsOf(attrs);
        const holder = stack.findLast((frame) => frame.name !== `template`);
        const nudge = name === `Icon` ? nudgeOf(words) : undefined;
        const why =
            nudge === undefined
                ? undefined
                : `\`${nudge}\` nudges an <Icon> by hand: \`.ui-icon\` sits on the text it labels, and leading an \`items-start\` line it centres on the first row itself, at every size`;
        // A line is read once, at the first element after its glyph: the words whose line the glyph centres on.
        const led = holder?.glyphLed === true && holder.read !== true && name !== `Icon` && name !== `template`;
        for (const said of [why, led ? misreadLine(holder, words) : undefined]) {
            if (said !== undefined) {
                findings.push({ at: at(path, scan, index), why: said });
            }
        }
        if (holder !== undefined && holder.line) {
            holder.glyphLed ||= name === `Icon` && holder.read !== true;
            holder.read ||= led;
        }
        return { name, words, line: /(?:^|\s)items-start(?:\s|$)/u.test(words) };
    });
    return findings;
};
