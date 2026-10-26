// Pins how button-tiers reads a <Button>'s rank: every one names its tier, two bright ones never show side by side, a
// bright one is not repeated by v-for, a way out is quiet, and `tone="accent"` is gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonRankFindings } from "./lib/button-ranks.mjs";

const whys = (template) => buttonRankFindings(`X.vue`, `<template>\n${template}\n</template>`).map(({ at, why }) => `${at.split(`:`)[1]} ${why.split(`:`)[0]}`);

test("a Button that names no tier is found; a literal, a bound tier, a spread look and gilded all name one", () => {
    assert.deepEqual(whys(`<Button label="Save" />`), [`2 <Button> names no tier, so it is bright by default`]);
    assert.deepEqual(whys(`<Button tier="boring" />\n<Button :tier="x ? \`quiet\` : \`boring\`" />\n<Button v-bind="look" />\n<Button tier="loud" gilded />`), []);
});

test("two bright Buttons side by side are found, and a v-if chain or a nested element keeps them apart", () => {
    assert.equal(whys(`<div><Button tier="accent" /><Button tier="loud" /></div>`).length, 2);
    assert.deepEqual(whys(`<div><Button v-if="a" tier="accent" /><Button v-else tier="accent" /></div>`), []);
    assert.deepEqual(whys(`<div><Button v-if="a" tier="accent" /><Button v-else-if="b" tier="accent" /><Button v-else tier="accent" /></div>`), []);
    assert.deepEqual(whys(`<div><Button tier="accent" /><div><Button tier="accent" /></div></div>`), []);
    // Two v-if's are two chains: both can be true.
    assert.equal(whys(`<div><Button v-if="a" tier="accent" /><Button v-if="b" tier="accent" /></div>`).length, 2);
    // A sibling between them ends the chain.
    assert.equal(whys(`<div><Button v-if="a" tier="accent" /><span /><Button tier="accent" /></div>`).length, 2);
    assert.deepEqual(whys(`<div><Button tier="accent" /><Button tier="boring" /><Button tier="quiet" /></div>`), []);
});

test("a template that draws nothing folds its Buttons into the parent with its own branch", () => {
    assert.deepEqual(whys(`<div><template v-if="a"><Button tier="accent" /></template><template v-else><Button tier="accent" /></template></div>`), []);
    assert.equal(whys(`<div><template v-if="a"><Button tier="accent" /></template><Button tier="accent" /></div>`).length, 2);
    // A named slot is somebody else's surface.
    assert.deepEqual(whys(`<Card><template #actions><Button tier="accent" /></template><Button tier="accent" /></Card>`), []);
});

test("a bright Button repeated by v-for is found, directly or through a template", () => {
    assert.equal(whys(`<div><Button v-for="x in xs" :key="x" tier="accent" /></div>`).length, 1);
    assert.equal(whys(`<div><template v-for="x in xs" :key="x"><Button tier="accent" /></template></div>`).length, 1);
    assert.deepEqual(whys(`<div><Button v-for="(x, at) in xs" :key="x" :tier="at === 0 ? \`accent\` : \`boring\`" /></div>`), []);
});

test("the kit's words for leaving are quiet, a retired accent tone is found, and a reason excuses a site", () => {
    assert.equal(whys(`<Button tier="boring" :label="t(\`ui.action.cancel\`)" />`).length, 1);
    assert.equal(whys(`<Button tier="boring">{{ t(\`ui.action.dismiss\`) }}</Button>`).length, 1);
    assert.deepEqual(whys(`<Button tier="quiet" :label="t(\`ui.action.cancel\`)" />\n<Button tier="accent" :label="t(\`ui.action.close\`)" />`), []);
    assert.equal(whys(`<Button tier="quiet" tone="accent" />`).length, 1);
    assert.deepEqual(whys(`<div>\n<!-- allow(buttons): two equal answers to one question -->\n<Button tier="accent" />\n<Button tier="accent" />\n</div>`), []);
});
