import type { WebchatPublicConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { styles } from "./styles.js";

/* These pin the widget to intentic's palette with NUMBERS, because that is the only way the claim survives.
 * "Looks like the app" is not checkable, and the values below were not chosen here: they were sampled out of a
 * screenshot of the running app and re-derived from @intentic/ui's oklch tokens, which agreed. If a token
 * moves in the app, one of these fails and says which. */

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

// The value the app's own transcript paints an assistant bubble: `color-mix(overlay 35%, transparent)` over the
// scroller's card, which in dark is #312d29 over #201c19. Sampled from the app: #26221e.
test(`the dark bubbles are the app's two chat surfaces, not a flat panel and a block of accent`, () => {
    const sheet = styles(config());
    expect(sheet).toContain(`--bubble-agent: #26221f`);
    expect(sheet).toContain(`--bubble-visitor: #292522`);
    // Who spoke is said with a surface step and a tinted edge. The accent is never the bubble's ground: white on
    // brand-600 is 3.15:1, and that pairing was the widget's worst-contrast element.
    expect(sheet).toContain(`.msg.visitor { align-self: flex-end; background: var(--bubble-visitor); border: 1px solid var(--accent-line); }`);
});

/* The accent stepped for the scheme: the widget's stand-in for the app's ramp, which uses brand-700 as ink in
 * light and brand-400 in dark. Landing within a step of both is the whole point of pulling 15% toward the
 * scheme's extreme, so the numbers are asserted against the ramp they imitate. */
test(`the accent is stepped per scheme, landing beside the ramp steps the app uses for ink`, () => {
    const sheet = styles(config());
    expect(sheet).toContain(`--accent-ink: #c26000`); // light; brand-700 is #c25600
    expect(sheet).toContain(`--accent-ink: #e88626`); // dark;  brand-500 is #e48233
});

test(`the label on a solid accent is the one that actually contrasts, not a hardcoded white`, () => {
    // Intentic's orange is light enough that near-black wins: 5.36:1 against white's 3.15:1.
    expect(styles(config())).toContain(`--on-accent: #201c19`);
    // A dark brand gets the other answer: proof the pick is derived rather than tuned to the default.
    expect(styles(config({ accent: `#1a3d8f` }))).toContain(`--on-accent: #ffffff`);
});

/* The reason every value above is a literal. Both features landed in 2023, and here they would be carrying
 * bubble BACKGROUNDS: an unsupported `color-mix()` is invalid at computed-value time, so the bubble paints
 * nothing rather than paints slightly wrong. */
test(`the shipped sheet contains no color-mix() or oklch() for a browser to fail to understand`, () => {
    const sheet = styles(config());
    expect(sheet).not.toContain(`color-mix(`);
    expect(sheet).not.toContain(`oklch(`);
});

test(`an accent the maths cannot read renders as the brand orange rather than half-derived`, () => {
    const sheet = styles(config({ accent: `rebeccapurple` }));
    expect(sheet).toContain(`--accent: #e47100`);
    expect(sheet).not.toContain(`rebeccapurple`);
    // Every derived value still resolves, which is what the fallback is for.
    expect(sheet).toContain(`--accent-wash: `);
    expect(sheet).toContain(`--accent-ring: `);
});

// Light and dark go through one generator, so a token added to one cannot be missing from the other.
test(`both schemes emit the same set of custom properties`, () => {
    const sheet = styles(config());
    const dark = sheet.slice(sheet.indexOf(`prefers-color-scheme: dark`));
    const names = (source: string): string[] => [...source.matchAll(/^\s*(--[a-z-]+):/gm)].map((match) => match[1]!).sort();
    const darkNames = names(dark);
    expect(darkNames.length).toBeGreaterThan(10);
    // The light block is everything before the media query, plus the radius/gap tokens it alone declares.
    expect(names(sheet.slice(0, sheet.indexOf(`prefers-color-scheme: dark`)))).toEqual(expect.arrayContaining(darkNames));
});
