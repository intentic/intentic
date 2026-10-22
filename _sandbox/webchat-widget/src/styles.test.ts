import type { WebchatPublicConfig } from "@intentic/sandbox-contract/schemas/automations";
import { styles } from "./styles.js";

// Custom accents must stay readable and fall back consistently when their colour cannot be parsed.

const config = (overrides: Partial<WebchatPublicConfig> = {}): WebchatPublicConfig => ({
    automationId: `a1`,
    title: `Ask Northwind`,
    greeting: `Hi!`,
    accent: `#e47100`, // the daemon's default, brand-600
    position: `bottom-right`,
    access: `public`,
    requireName: false,
    antiBot: `off`,
    aiDisclosure: true,
    ...overrides,
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
