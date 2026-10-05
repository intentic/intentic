import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* Request and route activity must not start CSS animations: Chrome DevTools rebuilds an open Styles editor when those animations start or stop. */

const here = import.meta.dirname;
const uiRoot = resolve(here, `../../../ui/src`);
const extensionsRoot = resolve(here, `../../../../_extensions`);
const utilities = resolve(uiRoot, `styles/utilities.css`);
const requestDrivenStyles = [
    resolve(uiRoot, `styles/press.css`),
    resolve(uiRoot, `styles/file-viewer.css`),
    resolve(here, `../features/workspace/explorer/WorkspaceTree.vue`),
];

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

// Every editor source a reader's motion could be decided in, scripts and stylesheets alike: the app, the kit, the
// extensions. The motion module is the one place the OS is asked (@intentic/ui/motion, choice.ts and loops.ts).
const motionModule = resolve(uiRoot, `motion`);
const editorFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== `node_modules` && entry.name !== `dist` && full !== motionModule) {
                out.push(...editorFiles(full));
            }
        } else if (/\.(ts|vue|css)$/.test(entry.name) && !entry.name.endsWith(`.test.ts`)) {
            out.push(full);
        }
    }
    return out;
};
const appRoot = resolve(here, `..`);

describe(`reduced motion`, () => {
    it(`asks the OS about reduced motion in the motion module alone`, () => {
        // A media query or a matchMedia call anywhere else answers to the OS behind the reader's back: the Appearance
        // setting's On would not move it, and its Off would not still it. Read `data-motion` (motion.css) instead.
        const askers = [appRoot, uiRoot, ...everyExtensionSrc]
            .flatMap(editorFiles)
            .filter((file) => readFileSync(file, `utf8`).includes(`prefers-reduced-motion`));
        expect(askers.map((file) => file.slice(resolve(here, `../../../..`).length + 1))).toEqual([]);
    });

    it(`keeps request-driven CSS animation utilities out of app source`, () => {
        expect([...animationClasses()].toSorted()).toEqual([]);
    });

    it(`keeps the answer central: no per-call-site opt-outs`, () => {
        // A `motion-reduce:` variant in a component is the habit this replaced: it hides the decision in markup
        // nobody greps, and it is only ever written by whoever happened to remember.
        const strays = everySource.filter((text) => text.includes(`motion-reduce:`)).length;
        expect(strays, `motion-reduce: belongs in utilities.css, not at a call site`).toBe(0);
    });

    it(`keeps request-backed placeholders and effects outside CSS Animations`, () => {
        const skeleton = readFileSync(utilities, `utf8`).match(/\.skeleton\s*\{[^}]*\}/)?.[0];
        expect(skeleton).toEqual(expect.stringContaining(`background-color`));
        expect(skeleton).not.toMatch(/\banimation\s*:/);
        // Its motion is SMIL in the SVG its mask is drawn from, in every scheme and under reduced motion alike: a
        // placeholder standing still beside a slow request reads as a broken one.
        expect(skeleton).toEqual(expect.stringContaining(`mask-image: var(--ui-skeleton-sheen)`));
        const sheens = [...readFileSync(utilities, `utf8`).matchAll(/--ui-skeleton-sheen:\s*url\("([^"]*)"\)/g)].map((match) => decodeURIComponent(match[1] ?? ``));
        expect(sheens).toHaveLength(3);
        for (const sheen of sheens) {
            expect(sheen).toMatch(/<animate [^>]*repeatCount='indefinite'/);
        }
        for (const file of requestDrivenStyles) {
            expect(readFileSync(file, `utf8`), `${file} starts motion from request or navigation state`).not.toMatch(/\banimation\s*:/);
        }
    });
});
