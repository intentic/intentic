// Reads the custom properties of the editor's colour stylesheets and evaluates one to a colour. Only the syntax those
// files use is understood (var(), color-mix(), oklch(), hex, transparent); anything else stops the run with its text, so
// a new construct in the CSS is a loud failure here, never a wrong colour in the app.
import { fromOklch, fromSrgb, mix, TRANSPARENT } from "./colour.mjs";

/** Every `--name: value;` in `css`, in order, with the selector or at-rule of the block it sits in. */
export const declarations = (css) => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, ``);
    const found = [];
    for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const scope = block[1].trim();
        for (const [, name, value] of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
            found.push({ scope, name, value: value.trim() });
        }
    }
    return found;
};

// The arguments of a function call whose name is already consumed: the text up to its matching parenthesis, split on
// the commas at its own level.
const argumentsOf = (text, open) => {
    let depth = 0;
    let start = open + 1;
    const parts = [];
    for (let i = open; i < text.length; i++) {
        const char = text[i];
        if (char === `(`) {
            depth++;
        } else if (char === `)` && --depth === 0) {
            parts.push(text.slice(start, i).trim());
            return { parts, end: i + 1 };
        } else if (char === `,` && depth === 1) {
            parts.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    throw new Error(`unbalanced parentheses in ${text}`);
};

const call = (text, name) => {
    if (!text.startsWith(`${name}(`)) {
        return undefined;
    }
    const { parts, end } = argumentsOf(text, name.length);
    if (text.slice(end).trim() !== ``) {
        throw new Error(`trailing text after ${name}(): ${text}`);
    }
    return parts;
};

const unit = (token) => (token.endsWith(`%`) ? Number(token.slice(0, -1)) / 100 : Number(token));

// One color-mix() operand: a colour with an optional percentage before or after it.
const operand = (text, evaluate) => {
    const before = text.match(/^([\d.]+%)\s+([\s\S]+)$/);
    if (before !== null) {
        return { share: unit(before[1]), colour: evaluate(before[2]) };
    }
    const after = text.match(/^([\s\S]+?)\s+([\d.]+%)$/);
    if (after !== null) {
        return { colour: evaluate(after[1]), share: unit(after[2]) };
    }
    return { colour: evaluate(text) };
};

const hexColour = (text) => {
    const digits = text.slice(1);
    const full = digits.length <= 4 ? [...digits].map((d) => d + d).join(``) : digits;
    if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(full)) {
        throw new Error(`not a hex colour: ${text}`);
    }
    const bytes = full.match(/../g).map((pair) => Number.parseInt(pair, 16) / 255);
    return fromSrgb(bytes.slice(0, 3), bytes[3] ?? 1);
};

/**
 * Evaluates `text` to a colour, looking custom properties up with `lookup(name)`, which returns the raw value text
 * of a declaration (or undefined).
 */
export const evaluate = (text, lookup, seen = new Set()) => {
    const value = text.trim();
    const recurse = (inner) => evaluate(inner, lookup, seen);
    const variable = call(value, `var`);
    if (variable !== undefined) {
        const [name, fallback] = variable;
        if (seen.has(name)) {
            throw new Error(`${name} refers to itself`);
        }
        const found = lookup(name) ?? fallback;
        if (found === undefined) {
            throw new Error(`${name} is not declared`);
        }
        return evaluate(found, lookup, new Set([...seen, name]));
    }
    const mixed = call(value, `color-mix`);
    if (mixed !== undefined) {
        const [space, first, second] = mixed;
        const a = operand(first, recurse);
        const b = operand(second, recurse);
        return mix(space.replace(/^in\s+/, ``), a.colour, a.share, b.colour, b.share);
    }
    const oklch = call(value, `oklch`);
    if (oklch !== undefined) {
        const [channels, alpha] = oklch[0].split(`/`).map((part) => part.trim());
        const [l, c, h] = channels.split(/\s+/).map(unit);
        return fromOklch(l, c, h, alpha === undefined ? 1 : unit(alpha));
    }
    if (value.startsWith(`#`)) {
        return hexColour(value);
    }
    if (value === `transparent`) {
        return TRANSPARENT;
    }
    throw new Error(`no colour reading for ${value}`);
};
