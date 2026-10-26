// THE RANK EACH <Button> IS GIVEN, read off one template. Brightness says "this is the step we are asking you to take",
// so a tier is a decision made at every call site, never a default. The owner found bright and dark buttons used
// "quite randomly" (2026-10-26): 247 of 812 named no tier and came out bright by default. The rule, in the order a
// reader asks it (button.ts holds the same words):
//   quiet  — leaves, cancels, dismisses, goes back, shows or hides; with tone="danger", the press that only starts a
//            removal (its confirmation is the accent one).
//   accent — completes what this surface is open for: a form's or dialog's submit, the yes to a question the app
//            asked, the one way forward from a failure, blocker or empty list. One at a time per surface.
//   boring — everything else: a tool the reader uses when they choose (scan, clean, rebuild, run, open, download, add
//            to a list), and the alternatives beside the accent one.
//   loud   — the page's one paid or turn-it-on step.
// What this reads: every <Button> names its tier; no two bright ones (accent, loud) can show side by side; a bright one
// is not repeated by v-for; the shared dismissive labels are quiet; `tone="accent"` is retired.
import { at, blank, excusedAt, tags, VOID } from "./templates.mjs";

/** A tier the call site decided: a literal one, a bound one, a look object spread on, or the gilded variant. */
const NAMES_TIER = /(?:^|\s)(?:tier="\w+"|:tier=|v-bind:tier=|v-bind=|gilded(?=[\s=/]|$))/u;
const STATIC_TIER = /(?:^|\s)tier="(\w+)"/u;
const GILDED = /(?:^|\s)gilded(?=[\s=/]|$)/u;
const BRIGHT = new Set([`accent`, `loud`]);
/** The kit's own words for leaving: whatever the surface, these are a way out, never the step forward. */
const DISMISSIVE = /t\(\s*`ui\.action\.(?:cancel|dismiss|skip|back|no|keepOpen)`\s*\)/u;
const ACCENT_TONE = /(?:^|\s)tone="accent"/u;
const V_IF = /(?:^|\s)v-if=/u;
const V_ELSE = /(?:^|\s)v-else(?:-if)?(?=[\s=/]|$)/u;
const V_FOR = /(?:^|\s)v-for=/u;
const SLOT = /(?:^|\s)(?:#|v-slot)/u;

const UNNAMED = `<Button> names no tier, so it is bright by default: say what it is — \`tier="quiet"\` if it leaves, cancels or dismisses; \`tier="accent"\` if it completes what this surface is open for (submit, the yes to a question asked, the way forward from a failure or an empty list); \`tier="boring"\` for every other tool`;
const ACCENT_TONE_WHY = `\`tone="accent"\` is retired: on the accent tier it says nothing, and on a quiet one it paints a link as a button — a link is \`ui.textButton()\`, an aside is plain \`tier="quiet"\``;
const DISMISSIVE_WHY = `a way out (Cancel, Dismiss, Skip, Back, No) is \`tier="quiet"\`: filled, it competes with the step it sits beside`;
const REPEATED_WHY = `a bright <Button> repeated by v-for draws one bright button per item: the step forward is one press, so bind the tier to the first (\`:tier="at === 0 ? \\\`accent\\\` : \\\`boring\\\`"\`) or make the repeated action boring`;
const SIDE_BY_SIDE_WHY = `two bright <Button>s (accent or loud) can show side by side here: a surface asks for one step at a time, so the other one is a tool (\`tier="boring"\`) or a way out (\`tier="quiet"\`)`;

// Two buttons can't show together when some v-if chain puts them on different branches.
const exclusive = (a, b) => a.branches.some((one) => b.branches.some((other) => one.id === other.id && one.branch !== other.branch));

/** The bright buttons among one element's children that can show at the same time, or that a v-for repeats. */
const brightClashes = (buttons) => {
    const bright = buttons.filter((button) => button.bright && !button.excused);
    return bright
        .filter((button) => button.repeated || bright.some((other) => other !== button && !exclusive(button, other)))
        .map((button) => ({ at: button.at, why: button.repeated ? REPEATED_WHY : SIDE_BY_SIDE_WHY }));
};

/** What one <Button>'s own markup says wrong about its rank. `label` is its attributes and, unless it closes itself, its content. */
const ownFindings = (attrs, label) => {
    const tier = attrs.match(STATIC_TIER)?.[1];
    return [
        NAMES_TIER.test(attrs) ? undefined : UNNAMED,
        ACCENT_TONE.test(attrs) ? ACCENT_TONE_WHY : undefined,
        tier !== undefined && tier !== `quiet` && DISMISSIVE.test(label) ? DISMISSIVE_WHY : undefined,
    ].filter((why) => why !== undefined);
};

// Where an element sits in its parent's v-if chain: a v-if opens one, v-else(-if) continues it, anything else ends it.
const placeIn = (parent, attrs, next) => {
    if (V_IF.test(attrs)) {
        parent.chain = { id: next(), branch: 0 };
    } else if (V_ELSE.test(attrs) && parent.chain !== undefined) {
        parent.chain = { id: parent.chain.id, branch: parent.chain.branch + 1 };
    } else {
        parent.chain = undefined;
    }
    return parent.chain;
};

// A `template` with no slot draws nothing, so its buttons count as the parent's, carrying its branch and its loop.
const foldInto = (parent, frame) => {
    for (const button of frame.buttons) {
        parent.buttons.push({
            ...button,
            branches: frame.own === undefined ? button.branches : [...button.branches, frame.own],
            repeated: button.repeated || V_FOR.test(frame.attrs),
        });
    }
};

// One <Button>'s own record among its parent's children, and what its markup says wrong about its rank.
const readButton = ({ path, source, scan }, { attrs, selfClosing, index }, own) => {
    const where = at(path, scan, index);
    const excused = excusedAt(source, scan, index, `buttons`);
    const tier = attrs.match(STATIC_TIER)?.[1];
    const button = {
        at: where,
        bright: (tier !== undefined && BRIGHT.has(tier)) || GILDED.test(attrs),
        repeated: V_FOR.test(attrs),
        branches: own === undefined ? [] : [own],
        excused,
    };
    const end = selfClosing === `` ? scan.indexOf(`</Button>`, index) : -1;
    const found = excused ? [] : ownFindings(attrs, end === -1 ? attrs : scan.slice(index, end)).map((why) => ({ at: where, why }));
    return { button, found };
};

/** Every finding about the rank of the <Button>s in one template, as `{ at, why }`. */
export const buttonRankFindings = (path, source) => {
    const file = { path, source, scan: blank(source) };
    const findings = [];
    const stack = [{ name: `#file`, attrs: ``, chain: undefined, buttons: [] }];
    let chains = 0;
    const next = () => (chains += 1);

    const close = (name) => {
        const open = stack.findLastIndex((frame) => frame.name === name);
        if (open <= 0) {
            return;
        }
        const frame = stack[open];
        if (frame.name === `template` && !SLOT.test(frame.attrs)) {
            foldInto(stack[open - 1], frame);
        } else {
            findings.push(...brightClashes(frame.buttons));
        }
        stack.length = open;
    };

    const enter = (tag) => {
        const parent = stack.at(-1);
        const own = placeIn(parent, tag.attrs, next);
        if (tag.name === `Button`) {
            const { button, found } = readButton(file, tag, own);
            parent.buttons.push(button);
            findings.push(...found);
        }
        if (tag.selfClosing === `` && !VOID.has(tag.name)) {
            stack.push({ name: tag.name, attrs: tag.attrs, own, chain: undefined, buttons: [] });
        }
    };

    for (const tag of tags(file.scan)) {
        if (tag.closing === ``) {
            enter(tag);
        } else {
            close(tag.name);
        }
    }
    return findings;
};
