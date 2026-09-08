import type { WebchatPublicConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { styles } from "./styles.js";

// Pins the widget's palette to intentic's numbers, sampled from the app and cross-checked against @intentic/ui's oklch
// tokens; a moved token fails here.

const config = (overrides: Partial<WebchatPublicConfig> = {}): WebchatPublicConfig => ({
    automationId: `a1`,
    title: `Ask Northwind`,
    greeting: `Hi!`,
    accent: `#e47100`, // the daemon's default, brand-600
    position: `bottom-right`,
    access: `public`,
    requireName: false,
    antiBot: `off`,
    ...overrides,
});

// Expected hex is the app's own bubble color: color-mix(overlay 35%, transparent) over the scroller card, sampled as
// #26221e in dark.
test(`the dark bubbles are the app's two chat surfaces, not a flat panel and a block of accent`, () => {
    const sheet = styles(config());
    expect(sheet).toContain(`--bubble-agent: #26221f`);
    expect(sheet).toContain(`--bubble-visitor: #292522`);
    expect(sheet).toContain(`.msg.visitor { align-self: flex-end; background: var(--bubble-visitor); border: 1px solid var(--accent-line); }`);
});

// Accent is stepped 15% toward the scheme's extreme, mimicking the app's ink ramp (brand-700 light, brand-400 dark);
// asserted against those steps.
test(`the accent is stepped per scheme, landing beside the ramp steps the app uses for ink`, () => {
    const sheet = styles(config());
    expect(sheet).toContain(`--accent-ink: #c26000`); // light; brand-700 is #c25600
    expect(sheet).toContain(`--accent-ink: #e88626`); // dark;  brand-500 is #e48233
});

test(`the label on a solid accent is the one that actually contrasts, not a hardcoded white`, () => {
    // Near-black wins over white for intentic's light orange: 5.36:1 vs 3.15:1.
    expect(styles(config())).toContain(`--on-accent: #201c19`);
    expect(styles(config({ accent: `#1a3d8f` }))).toContain(`--on-accent: #ffffff`);
});

// Every value above is a literal: an unsupported color-mix()/oklch() is invalid at computed-value time, so the bubble
// would paint nothing, not slightly wrong.
test(`the shipped sheet contains no color-mix() or oklch() for a browser to fail to understand`, () => {
    const sheet = styles(config());
    expect(sheet).not.toContain(`color-mix(`);
    expect(sheet).not.toContain(`oklch(`);
});

test(`an accent the maths cannot read renders as the brand orange rather than half-derived`, () => {
    const sheet = styles(config({ accent: `rebeccapurple` }));
    expect(sheet).toContain(`--accent: #e47100`);
    expect(sheet).not.toContain(`rebeccapurple`);
    expect(sheet).toContain(`--accent-wash: `);
    expect(sheet).toContain(`--accent-ring: `);
});

// Light and dark share one generator, so a token added to one set cannot be missing from the other.
test(`both schemes emit the same set of custom properties`, () => {
    const sheet = styles(config());
    const dark = sheet.slice(sheet.indexOf(`prefers-color-scheme: dark`));
    const names = (source: string): string[] => [...source.matchAll(/^\s*(--[a-z-]+):/gm)].map((match) => match[1]!).sort();
    const darkNames = names(dark);
    expect(darkNames.length).toBeGreaterThan(10);
    // Light block is everything before the dark media query, including the radius/gap tokens declared only there.
    expect(names(sheet.slice(0, sheet.indexOf(`prefers-color-scheme: dark`)))).toEqual(expect.arrayContaining(darkNames));
});
