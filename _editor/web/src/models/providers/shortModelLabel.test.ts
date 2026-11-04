import { shortModelLabel } from "./shortModelLabel";

it(`drops the brand word ahead of a family name and its version`, () => {
    expect(shortModelLabel(`Claude Opus 5.5`)).toBe(`Opus 5.5`);
    expect(shortModelLabel(`Claude Sonnet 4.6`)).toBe(`Sonnet 4.6`);
    expect(shortModelLabel(`Claude Haiku 4.5`)).toBe(`Haiku 4.5`);
    expect(shortModelLabel(`Claude Opus 4.6 (1M)`)).toBe(`Opus 4.6 (1M)`);
});

it(`leaves every label that would stop naming a model without its brand`, () => {
    for (const label of [`Claude Code`, `Claude 3.5 Sonnet`, `Claude Opus`, `Gemini 3.8 Flash`, `GPT-5.6`, `GPT 6.1 Sol`, `Grok Code Fast 1`, `Grok 9`, `Kimi K2`, `Auto`, ``]) {
        expect(shortModelLabel(label)).toBe(label);
    }
});
