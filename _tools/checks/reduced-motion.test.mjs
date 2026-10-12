// Pins each rule reduced-motion reads a file by: the OS asked about motion, a CSS animation utility, a per-site
// motion-reduce: variant, and a skeleton that moves by SMIL rather than a CSS animation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { animationClasses, cssAnimations, motionAskers, motionReduceVariants, skeletonProblems } from "./lib/reduced-motion.mjs";

const lines = (found) => found.map(({ line }) => line);

test("a media query or matchMedia string asks the OS", () => {
    // The one that shipped in _editor/web/src/features/browsers/BrowserTabStrip.vue (4e1f67a870).
    assert.deepEqual(lines(motionAskers(`<style>\n@media (prefers-reduced-motion: reduce) {\n  .tab { transition: none; }\n}\n</style>`)), [2]);
    assert.deepEqual(lines(motionAskers("const still = matchMedia(`(prefers-reduced-motion: reduce)`).matches;")), [1]);
    assert.deepEqual(lines(motionAskers(`html[data-motion="reduced"] .tab { transition: none; }`)), []);
});

test("an animate-* utility is judged, animate-none is not", () => {
    // The ones that shipped in the kit's Beacon.vue (4c132e4b4e).
    const beacon = `<span class="absolute inline-flex size-full animate-ping rounded-full" />\n<span class="ring-2 motion-reduce:ring-primary-500/40" />`;
    assert.deepEqual(
        animationClasses(beacon).map(({ line, match }) => [line, match]),
        [[1, `animate-ping`]],
    );
    assert.deepEqual(lines(motionReduceVariants(beacon)), [2]);
    assert.deepEqual(animationClasses(`<div class="animate-none" />`), []);
});

test("an animation: declaration starts a CSS animation, a transition does not", () => {
    assert.deepEqual(lines(cssAnimations(`.press {\n  animation: press 120ms ease-out;\n}`)), [2]);
    assert.deepEqual(lines(cssAnimations(`.press { transition: transform 120ms; animation-name: none }`)), []);
});

const sheen = (scheme) => `--ui-skeleton-sheen: url("data:image/svg+xml,%3Csvg%3E%3Canimate attributeName='x1' dur='1.8s' repeatCount='indefinite'/%3E%3C/svg%3E"); /* ${scheme} */`;
const utilities = (skeleton, sheens = [sheen(`light`), sheen(`dark`), sheen(`contrast`)]) => `.skeleton {${skeleton}}\n${sheens.join("\n")}`;
const SKELETON = ` background-color: var(--ui-skeleton-ink); mask-image: var(--ui-skeleton-sheen); `;

test("a skeleton masked by a looping SMIL sheen in every scheme is right", () => {
    assert.deepEqual(skeletonProblems(utilities(SKELETON)), []);
});

test("a skeleton that animates in CSS, lost its mask or a scheme's sheen, or whose sheen stands still is not", () => {
    assert.deepEqual(skeletonProblems(utilities(`${SKELETON} animation: pulse 2s infinite;`)), [`.skeleton starts a CSS animation`]);
    assert.deepEqual(skeletonProblems(utilities(` background-color: red; `)), [`.skeleton is not masked by var(--ui-skeleton-sheen)`]);
    assert.deepEqual(skeletonProblems(utilities(SKELETON, [sheen(`light`), sheen(`dark`)])), [`2 --ui-skeleton-sheen definitions, where every scheme has one (3)`]);
    assert.deepEqual(skeletonProblems(utilities(SKELETON, [sheen(`light`), sheen(`dark`), `--ui-skeleton-sheen: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");`])), [
        `--ui-skeleton-sheen #3 has no <animate repeatCount='indefinite'>`,
    ]);
    assert.deepEqual(skeletonProblems(`.bar { color: red }`), [`no .skeleton rule`]);
});
