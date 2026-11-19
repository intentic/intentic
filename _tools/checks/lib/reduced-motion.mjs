// What reduced-motion.mjs reads a file for, rule by rule. Kept apart from the check so its suite can feed it text.

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const linesOf = (text, pattern) => [...text.matchAll(pattern)].map((match) => ({ line: lineOf(text, match.index), match: match[0] }));

/** Each place `text` asks the OS about reduced motion itself, as a media query or a matchMedia string. */
export const motionAskers = (text) => linesOf(text, /prefers-reduced-motion/g);

/** Each CSS animation utility `text` names. `animate-none` is the absence of one, not an animation to have an opinion about. */
export const animationClasses = (text) => linesOf(text, /\banimate-[a-z0-9-]+/g).filter(({ match }) => match !== `animate-none`);

/** Each per-call-site `motion-reduce:` variant in `text`. */
export const motionReduceVariants = (text) => linesOf(text, /motion-reduce:/g);

/** Each CSS animation `text` starts: an `animation:` declaration. */
export const cssAnimations = (text) => linesOf(text, /\banimation\s*:/g);

/**
 * What is wrong with the skeleton placeholder in utilities.css, as sentences; empty when it is a background colour
 * masked by a SMIL sheen, with no CSS animation of its own, and every scheme's sheen loops. A sheen that holds a value
 * inside its interval is wrong too: while any SMIL animation in an image is active the browser redraws the image every
 * frame, so a held stretch repaints every bar on screen for nothing (docs/architecture/conventions.md, UI).
 */
export const skeletonProblems = (text) => {
    const skeleton = text.match(/\.skeleton\s*\{[^}]*\}/)?.[0];
    if (skeleton === undefined) {
        return [`no .skeleton rule`];
    }
    const problems = [];
    if (!skeleton.includes(`background-color`)) {
        problems.push(`.skeleton sets no background-color`);
    }
    if (/\banimation\s*:/.test(skeleton)) {
        problems.push(`.skeleton starts a CSS animation`);
    }
    if (!skeleton.includes(`mask-image: var(--ui-skeleton-sheen)`)) {
        problems.push(`.skeleton is not masked by var(--ui-skeleton-sheen)`);
    }
    const sheens = [...text.matchAll(/--ui-skeleton-sheen:\s*url\("([^"]*)"\)/g)].map((match) => decodeURIComponent(match[1] ?? ``));
    if (sheens.length !== 3) {
        problems.push(`${sheens.length} --ui-skeleton-sheen definitions, where every scheme has one (3)`);
    }
    for (const [index, sheen] of sheens.entries()) {
        const animates = [...sheen.matchAll(/<animate [^>]*>/g)].map(([tag]) => tag);
        if (!animates.some(loops)) {
            problems.push(`--ui-skeleton-sheen #${index + 1} never loops: no <animate> with repeatCount='indefinite' or begun again on its own end`);
        }
        for (const values of animates.map((tag) => / values='([^']*)'/.exec(tag)?.[1]).filter((found) => found !== undefined)) {
            if (values.split(`;`).some((value, at, all) => at > 0 && value.trim() === all[at - 1]?.trim())) {
                problems.push(
                    `--ui-skeleton-sheen #${index + 1} holds a value inside its interval (values='${values}'): put the rest between intervals instead`,
                );
            }
        }
    }
    return problems;
};

/** Whether an `<animate>` tag runs forever: repeated indefinitely, or begun again when its own interval ends
 *  (`id='a' begin='0s;a.end+.5s'`, the way a rest between beats is written so nothing is active during it). */
const loops = (tag) => {
    const id = / id='([^']*)'/.exec(tag)?.[1];
    const begin = / begin='([^']*)'/.exec(tag)?.[1] ?? ``;
    return tag.includes(`repeatCount='indefinite'`) || (id !== undefined && begin.split(`;`).some((at) => at.trim().startsWith(`${id}.end`)));
};
