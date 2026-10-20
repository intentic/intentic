import assert from "node:assert/strict";
import { test } from "node:test";
import { declarations, evaluate } from "./css.mjs";
import { roleColours } from "./roles.mjs";

const PRIMITIVES = `@theme { --color-white: #fff; --color-neutral-900: oklch(23% 0.008 65); /* a comment; with: colons */ }`;
const SEMANTIC = `
@theme {
    --color-surface-900: var(--color-neutral-900);
    --color-content: var(--role-content);
    --color-line:    var(--role-line);
    --color-not-a-role: var(--color-white);
}
:root {
    --role-content: var(--color-white);
    --role-line:    color-mix(in oklab, var(--color-content) 50%, transparent);
}
[data-mode="dark"] {
    --role-content: var(--color-surface-900);
}`;

test(`declarations keep the block each property sits in`, () => {
    assert.deepEqual(
        declarations(`:root { --a: #fff; } [data-mode="dark"] { --a: #000; }`).map(({ scope, name, value }) => [scope, name, value]),
        [
            [`:root`, `--a`, `#fff`],
            [`[data-mode="dark"]`, `--a`, `#000`],
        ],
    );
});

test(`every role resolves in each scheme, and a role built on another follows the scheme`, () => {
    const { light, dark } = roleColours(PRIMITIVES, SEMANTIC);
    assert.deepEqual(light, [
        [`content`, `#FFFFFFFF`],
        [`line`, `#80FFFFFF`],
    ]);
    assert.deepEqual(dark, [
        [`content`, `#FF201C19`],
        [`line`, `#80201C19`],
    ]);
});

test(`a value the generator cannot read stops it with the property's name`, () => {
    assert.throws(() => roleColours(``, `@theme { --color-x: var(--role-x); } :root { --role-x: rgb(1 2 3); }`), /--color-x: no colour reading for rgb\(1 2 3\)/);
    assert.throws(() => evaluate(`var(--a)`, (name) => (name === `--a` ? `var(--a)` : undefined)), /refers to itself/);
    assert.throws(() => evaluate(`var(--missing)`, () => undefined), /not declared/);
});
