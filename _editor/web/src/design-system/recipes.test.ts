import { ui } from "@intentic/ui/recipes";
import { diffMark, toneFill, toneInk, toneRim, toneTint, toneWash } from "@intentic/ui/tone";

/* The kit's recipes: a variant is chosen by name, the caller's layout lands last, and the call shape installed
   extensions were built against (`ui.x("classes")`) still draws the same control. */

const words = (classes: string): string[] => classes.split(` `).filter(Boolean).toSorted();

describe(`ui recipes`, () => {
    it(`draws the default when called with classes only, the shape extensions call through the host`, () => {
        expect(words(ui.iconButton(`shrink-0`))).toEqual(words(ui.iconButton({}, `shrink-0`)));
        expect(ui.iconButton(`shrink-0`)).toContain(`h-6 w-6`);
        expect(ui.linkButton()).toBe(ui.textButton());
        expect(ui.textAction()).toBe(ui.textButton({ tone: `quiet` }));
        expect(ui.inputSm(`w-20`)).toBe(ui.input({ size: `sm` }, `w-20`));
        expect(ui.inputInline()).toBe(ui.input({ size: `inline` }));
        expect(ui.sectionLabelSm()).toBe(ui.sectionLabel({ size: `xs` }));
    });

    it(`resolves a size variant to one box, not two`, () => {
        const lg = words(ui.iconButton({ size: `lg` }));
        expect(lg).toContain(`h-8`);
        expect(lg).not.toContain(`h-6`);
        expect(words(ui.textButton({ size: `xs` }))).toEqual(expect.arrayContaining([`text-2xs`, `gap-1`]));
        expect(words(ui.textButton({ size: `xs` }))).not.toContain(`text-xs`);
    });

    it(`lets a state variant outrank the tone it sits on`, () => {
        const on = words(ui.iconButton({ tone: `subtle`, on: true }));
        expect(on).toContain(`text-content`);
        expect(on).not.toContain(`text-subtle`);
        expect(words(ui.iconButton({ round: true }))).toContain(`rounded-full`);
        expect(words(ui.iconButton({ round: true }))).not.toContain(`rounded-md`);
    });

    it(`keeps the caller's layout and lets it win a conflict`, () => {
        expect(words(ui.iconButton({ size: `md` }, `ml-auto`, false, undefined))).toContain(`ml-auto`);
        expect(ui.chip({ on: true }, `shrink-0`)).toBe(`ui-chip ui-chip-on shrink-0`);
        expect(ui.chip({ on: false })).toBe(`ui-chip`);
        expect(ui.tab(true)).toBe(ui.tab({ active: true }));
    });
});

describe(`tone`, () => {
    it(`speaks one vocabulary at two strengths`, () => {
        expect(toneTint(`danger`)).toBe(`border-danger/40 bg-danger/10`);
        expect(toneTint(`danger`, `soft`)).toBe(`border-danger/20 bg-danger/5`);
        expect(toneWash(`warning`)).toBe(`bg-warning/10 text-warning`);
        expect(toneInk(`neutral`)).toBe(`text-subtle`);
    });

    it(`splits a tint into its rim and its fill, for a box that keeps the other half`, () => {
        expect(toneRim(`warning`)).toBe(`border-warning/40`);
        expect(toneFill(`warning`, `soft`)).toBe(`bg-warning/5`);
        expect(toneTint(`warning`)).toBe(`${toneRim(`warning`)} ${toneFill(`warning`)}`);
        expect(toneRim(`danger`, `strong`, `bg-card`)).toBe(`border-danger/40 bg-card`);
    });

    it(`puts a caller's own classes after the tone's`, () => {
        expect(toneTint(`info`, `soft`, `rounded-lg border px-4 py-3`)).toBe(`border-info/20 bg-info/5 rounded-lg border px-4 py-3`);
    });

    it(`marks a diff the same way wherever it is drawn`, () => {
        expect(diffMark(`removed`)).toContain(`line-through`);
        expect(diffMark(`added`, `rule`)).toBe(`border-l-2 border-success/60`);
    });
});

describe(`button tiers`, () => {
    it(`maps each tier and tone onto what PrimeVue and primeng.css draw`, async () => {
        const { primeLook } = await import(`@intentic/ui/button`);
        expect(primeLook({})).toEqual({ severity: undefined, text: false, class: `` });
        expect(primeLook({ tier: `boring` })).toMatchObject({ severity: `secondary`, text: false });
        expect(primeLook({ tier: `quiet` })).toMatchObject({ severity: `secondary`, text: true });
        expect(primeLook({ tier: `quiet`, tone: `accent` })).toMatchObject({ severity: undefined, text: true });
        expect(primeLook({ tier: `quiet`, tone: `danger` })).toMatchObject({ severity: `danger`, text: true });
        expect(primeLook({ tone: `warning` })).toMatchObject({ severity: `warn`, text: false });
        expect(primeLook({ tier: `loud` }).class).toBe(`ui-button-loud`);
        expect(primeLook({ gilded: true, thumb: true }).class).toBe(`ui-button-loud ui-button-gilded ui-button-thumb`);
    });
});
