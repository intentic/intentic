import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* THE MOTION BUDGET, MADE UNAVOIDABLE.
 *
 * `prefers-reduced-motion` is a preference the OS states plainly and this app used to honour by hand: three
 * call sites wrote `motion-reduce:animate-none` and thirty did not, because remembering is not a mechanism.
 * The answer now lives once, unlayered, in the design system's utilities.css — and this is what keeps it
 * whole: every animation class the app actually uses must be named there, or named here as a deliberate
 * exemption. Adding an animation therefore costs one line in one of two places, which is the point. The
 * failure this prevents is silent and invisible to whoever causes it: nobody who does not set the preference
 * can see that a new spinner ignores it.
 *
 * Scanned rather than listed, for the same reason the extension conformance tests scan: a list of "animations
 * we have" is a list that is wrong within a week. */

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, `../../ui/src`);
const extensionsRoot = resolve(here, `../../../_extensions`);
const stylesheet = resolve(uiRoot, `styles/utilities.css`);

const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== `node_modules` && entry.name !== `dist`) {
                out.push(...sourceFiles(full));
            }
        } else if ((entry.name.endsWith(`.ts`) || entry.name.endsWith(`.vue`)) && !entry.name.endsWith(`.test.ts`)) {
            out.push(full);
        }
    }
    return out;
};

const everyExtensionSrc = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, `src`)))
    .map((entry) => join(extensionsRoot, entry.name, `src`));

// Every surface a user can see: this app, the design system it draws with, and the extensions that render
// inside it. An extension's spinner is as much this app's motion as its own.
const everySource = [here, uiRoot, ...everyExtensionSrc].flatMap(sourceFiles).map((file) => readFileSync(file, `utf8`));

// `animate-none` is the absence of one, not an animation to have an opinion about.
const animationClasses = (): Set<string> => {
    const found = new Set<string>();
    for (const text of everySource) {
        for (const match of text.matchAll(/\banimate-[a-z0-9-]+/g)) {
            if (match[0] !== `animate-none`) {
                found.add(match[0]);
            }
        }
    }
    return found;
};

/* WHAT EACH ONE DOES WHEN THE PREFERENCE IS SET, and why that is the right answer for it. Three verdicts:
 *
 * `stopped` — the motion was decoration and the state it reported is carried by something still.
 * `slowed`  — the motion is load-bearing and stopping it would misreport (a frozen spinner reads as hung).
 * `kept`    — it is not movement. An opacity fade triggers nobody, and denying it is a cost with no benefit.
 *
 * Only `stopped` and `slowed` owe a rule in the stylesheet; `kept` is a decision recorded so that the next
 * person to look does not have to re-derive it. */
const DECIDED: Record<string, { readonly verdict: "stopped" | "slowed" | "kept"; readonly why: string }> = {
    "animate-pulse": { verdict: `stopped`, why: `decoration on a placeholder or a resting state` },
    "animate-spin": { verdict: `slowed`, why: `the app's only running indicator on a dozen surfaces` },
    "animate-fade-in": { verdict: `kept`, why: `opacity only — not movement` },
    "animate-fade-in-up": { verdict: `stopped`, why: `re-pointed at the fade-only keyframes, losing the 8px travel` },
    // Not an `animate-*` utility: the design system's loading placeholder owns its own sweep, in `components`.
    skeleton: { verdict: `stopped`, why: `content the reader cannot act on yet` },
};

// The unlayered block at the end of utilities.css. Sliced by brace depth rather than matched, so a rule added
// inside it is seen and one added after it is not.
const reducedMotionBlock = (): string => {
    const css = readFileSync(stylesheet, `utf8`);
    const start = css.indexOf(`@media (prefers-reduced-motion: reduce)`);
    expect(start, `utilities.css must carry a prefers-reduced-motion block`).toBeGreaterThan(-1);
    let depth = 0;
    for (let index = css.indexOf(`{`, start); index < css.length; index += 1) {
        if (css[index] === `{`) depth += 1;
        if (css[index] === `}`) {
            depth -= 1;
            if (depth === 0) return css.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated prefers-reduced-motion block`);
};

describe(`reduced motion`, () => {
    it(`has a recorded decision for every animation the app uses`, () => {
        const undecided = [...animationClasses()].filter((name) => DECIDED[name] === undefined).toSorted();
        expect(
            undecided,
            `New animation classes. Decide what each does under prefers-reduced-motion: add a rule to the block in ` +
                `_editor/ui/src/styles/utilities.css, then record the verdict in DECIDED here.`,
        ).toEqual([]);
    });

    it(`carries a rule for everything it says is stopped or slowed`, () => {
        const block = reducedMotionBlock();
        for (const [name, { verdict, why }] of Object.entries(DECIDED)) {
            if (verdict === `kept`) continue;
            expect(block, `${name} is recorded as ${verdict} (${why}) but the stylesheet never names it`).toContain(`.${name}`);
        }
    });

    it(`keeps the answer central — no per-call-site opt-outs`, () => {
        // A `motion-reduce:` variant in a component is the habit this replaced: it hides the decision in markup
        // nobody greps, and it is only ever written by whoever happened to remember.
        const strays = everySource.filter((text) => text.includes(`motion-reduce:`)).length;
        expect(strays, `motion-reduce: belongs in utilities.css, not at a call site`).toBe(0);
    });
});
