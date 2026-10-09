import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// EVERY HOVER FILL FADES, AT ONE PACE. motion.css gives any element carrying a `hover:bg-*`, `hover:text-*` or
// `hover:border-*` class the house fade (--motion-hover), but only while the element names no transition of its own:
// a `transition-opacity` or `transition-transform` beside the hover colour narrows the element to that one property,
// and its fill lands on the first frame again. That is how the Changes panel's FROM chips came to snap. An element that
// fades or turns AND takes a hover colour names Tailwind's `transition`, which covers both; and none picks its own
// `duration-*`, which is the other way two hovers end up disagreeing.

const here = import.meta.dirname;
const roots = [resolve(here, `..`), resolve(here, `../../../ui/src`), resolve(here, `../../../../_extensions`)];

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return [`node_modules`, `dist`, `vendor`].includes(entry.name) ? [] : sourceFiles(full);
        }
        return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith(`.test.ts`) ? [full] : [];
    });

// One class string at a time (a `class="…"` attribute or a string literal): the unit an element's classes are written in.
const classStrings = (text: string): string[] => [...text.matchAll(/class="([^"]*)"|`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)].map((match) => match.slice(1).find((group) => group !== undefined) ?? ``);

const HOVER_COLOUR = /(?:^|\s)(?:[\w/-]+:)*(?:group-)?hover(?:\/[\w-]+)?:(?:bg|text|border)-/;
const COLOUR_TRANSITION = /(?:^|\s)transition(?:-colors|-all|-\[[^\]]*(?:color|background)[^\]]*\])?(?=\s|$)/;
const NARROW_TRANSITION = /(?:^|\s)transition-(?:opacity|transform|shadow|\[[^\]]*\])(?=\s|$)/;
const OWN_DURATION = /(?:^|\s)duration-[\w[\]]+(?=\s|$)/;

describe(`hover fade`, () => {
    const offenders = roots.flatMap(sourceFiles).flatMap((file) =>
        classStrings(readFileSync(file, `utf8`))
            .filter((classes) => HOVER_COLOUR.test(classes))
            .filter((classes) => (NARROW_TRANSITION.test(classes) && !COLOUR_TRANSITION.test(classes)) || OWN_DURATION.test(classes))
            .map((classes) => `${file.slice(resolve(here, `../../../..`).length + 1)}: ${classes.trim().slice(0, 120)}`),
    );

    it(`never narrows a hover-coloured element's transition away from its colours, nor times it apart`, () => {
        expect(offenders).toEqual([]);
    });
});
