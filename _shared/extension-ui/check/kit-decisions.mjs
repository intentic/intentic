// THE KIT'S DECIDED LOOKS, read off one template: the rules row-tiers, mark-alignment, kit-substitutes and recipe-tiers
// judge every view by, in one place so their tests read the same functions the checks run. Each refuses a decision the
// owner made once, and had re-made view by view while a view could still state it: a header's count, caption, fill or
// spacing; a card laid in a card; rows of different heights; an icon nudged onto its line by a pixel that is right for
// one type size only; a section label, a tab strip, a search field or an open row drawn by hand; a chip's own box.
import { extensionUiRetired } from "../names.mjs";
import { at, classWordsOf, tags, VOID } from "./scan.mjs";

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The look the header owns (`ui.sectionLabel`, drawn only by <SectionHeader>): an uppercase, tracked label, spelled out or
// called for by the recipe's own name.
const HEADER_LOOK = (words) =>
    /\bui\.sectionLabel(?:Sm)?\b/u.test(words) ||
    (/(?:^|\s)uppercase(?:\s|$)/u.test(words) && /(?:^|\s)tracking-(?:wide|wider|widest)(?:\s|$)/u.test(words));
const SECTIONS = new Set([`RowGroup`, `Section`]);
// A parent that spaces what it holds: a gap, a vertical rhythm, or hairlines between them.
const SPACED = /(?:^|\s)(?:[\w@-]+:)*(?:gap-(?:y-)?[\d.[]|space-y-|divide-y)/u;
// A height on a row, at any breakpoint.
const ROW_HEIGHT = /(?:^|\s)(?:[\w@-]+:)*(?:min-h|max-h|h)-(?!0(?:\s|$))[\w.[\]/-]+/u;
const ELSE = /(?:^|\s)v-else(?:-if)?(?:[\s=>]|$)/u;

// What each removed prop was for, said where a call site still passes it: `extensionUiRetired` in names.mjs, the one
// record of them, whose `Component.prop` entries are read here under both spellings a template may use.
const kebab = (name) => name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
const RETIRED_PROPS = {};
for (const { name, why } of extensionUiRetired) {
    const [component, prop] = name.split(`.`);
    if (/^[A-Z]/u.test(component) && prop !== undefined) {
        RETIRED_PROPS[component] ??= {};
        RETIRED_PROPS[component][prop] = why;
        RETIRED_PROPS[component][kebab(prop)] = why;
    }
}

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

// ── 8, 10 · a group among another group's rows, a row's own height (a header drawn by hand, once rule 7 here, is
// `substituteFindings`' first rule, on every element rather than only on `<h1>`–`<h6>`)
const redecidedLooks = (name, words, parent) => [
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
 * A blanked template's section findings: a header decision taken at the call site (4), a group among another group's
 * rows (8), sections side by side with nothing spacing them (9), a row given a height (10).
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

// ── Substitutes ──────────────────────────────────────────────────────────────────────────────────────────────────

// Each kit primitive below was drawn by hand in a view before it existed, and was drawn by hand again after, by a view
// that did not know it did. Where a rule's primitive is defined, the rule does not apply: it is that primitive's own
// markup. `<th>`/`<tr>` are a table's column heads, which InfoTable draws in the label's type on purpose.
const OWNERS = {
    label: /(?:^|\/)_editor\/ui\/src\/components\/rows\/SectionHeader\.vue$/u,
    tabs: /(?:^|\/)_editor\/ui\/src\/components\/forms\/SegmentedControl\.vue$/u,
    search: /(?:^|\/)_editor\/ui\/src\/components\/forms\/SearchBar\.vue$/u,
    open: /(?:^|\/)_editor\/ui\/src\/components\/rows\/DisclosureRow\.vue$/u,
};
const TABLE_HEAD = new Set([`th`, `tr`, `thead`]);
const word = (name) => new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, `u`);
const SEARCH_DRESS = /(?:^|\s)ui-search(?:-band|-icon)?(?:\s|$)/u;
const FIELD = new Set([`input`, `InputText`]);

const SAYS = {
    label: (name) =>
        `<${name}> wears the section label's look (uppercase, tracked) by hand, so its size, spacing and what sits beside it are this view's to drift: a label over a part is <SectionHeader> (\`density="dense"\` in a menu, a drawer or a card), or <Section :label> around what it heads; words inside a row are not a heading and take no uppercase`,
    tabs: `a tab strip drawn by hand: <SegmentedControl> owns the roving tab stop, the arrow keys and the selected mark (\`variant="underline"\` for tabs that switch the parts of a page)`,
    search: `a search field drawn by hand: <SearchBar> (\`variant="panel"\` as a popover's first band, \`field\` above a list) owns the magnifier, the clear, Escape and the busy spin`,
    open: `the open row's wash put on by hand: an expanding row is <DisclosureRow>, which owns \`ui-row-open\` behind its header and drawer as one surface`,
};

/**
 * A blanked template's hand-drawn substitutes for a kit primitive, each as `{ index, rule, why }`: the section label's
 * look on any element (`label`), a tab strip (`tabs`), a search field (`search`), and the open row's wash (`open`).
 * The caller turns `index` into a line and reads `allow(substitutes)` there.
 */
export const substituteFindings = (path, scan) => {
    const findings = [];
    const owned = (rule) => OWNERS[rule].test(path);
    const add = (index, rule, why) => {
        if (!owned(rule)) {
            findings.push({ index, rule, why });
        }
    };
    // The open tag before this one, for a field that a magnifier glyph leads.
    let previous;
    for (const { closing, name, attrs, index } of tags(scan)) {
        if (closing !== ``) {
            previous = undefined;
            continue;
        }
        const words = classWordsOf(attrs);
        if (HEADER_LOOK(words) && !TABLE_HEAD.has(name)) {
            add(index, `label`, SAYS.label(name));
        }
        if (/(?:^|\s)role="tablist"/u.test(attrs) || /\bui\.tab\(/u.test(attrs)) {
            add(index, `tabs`, SAYS.tabs);
        }
        const ledByMagnifier = previous?.name === `Icon` && /(?:^|\s)name="search"/u.test(previous.attrs);
        if (SEARCH_DRESS.test(words) || (FIELD.has(name) && (/(?:^|\s)type="search"/u.test(attrs) || ledByMagnifier))) {
            add(index, `search`, SAYS.search);
        }
        if (word(`ui-row-open`).test(words)) {
            add(index, `open`, SAYS.open);
        }
        previous = { name, attrs };
    }
    return findings;
};

// ── Chips and pills ──────────────────────────────────────────────────────────────────────────────────────────────

// What a chip's or a pill's size owns: a padding, a height, a gap, a type size, a line height, a radius, at any variant.
const BOX_WORD =
    /^(?:p[xytblrse]?-|(?:min-|max-)?h-|size-|gap(?:-[xy])?-|leading-|rounded(?:-|$)|text-(?:4xs|3xs|2xs|xs|sm|base|lg|xl|2xl|\[[\d.]+r?em\]))/u;
const bareWord = (token) => token.replace(/^!/u, ``).replace(/^(?:[\w@[\]&>*/-]+:)+/u, ``).replace(/^!/u, ``);

/**
 * The words of a class list that restate a chip's or a status pill's box, which utilities.css decides once per size
 * (`ui.chip({ size, lead, trail })`, `ui-status-pill[-md|-inline]`): `kind` is which of the two the list draws, if
 * either. A `ui.chip(…)` call's own arguments are left out, since the recipe check reads those on their own.
 */
export const boxOverrides = (classes) => {
    const words = classes.replace(/ui\.chip\((?:[^()]|\([^()]*\))*\)/gu, ` ui-chip `);
    const kind = /(?:^|\s)ui-chip(?=\s|$)/u.test(words) ? `chip` : /(?:^|\s)ui-status-pill(?=\s|$)/u.test(words) ? `pill` : undefined;
    if (kind === undefined) {
        return { kind, words: [] };
    }
    return {
        kind,
        words: words
            .split(/\s+/u)
            .map((token) => token.replace(/^[`'"([{]+|[`'")\]},]+$/gu, ``))
            .filter((token) => BOX_WORD.test(bareWord(token))),
    };
};
