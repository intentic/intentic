import { example, GOLDEN } from "./golden.testing";
import { keyboardNameOf, layoutOf, layoutOptionsOf, STANDARD, variantOptionsOf } from "./keyboardCard";

// The keyboard as the card reads it: the layout in use by its name, every layout alphabetically, and the variants of the
// one picked. The answers are the contract's own examples of `ic os keyboard`.

const layouts = example(GOLDEN.keyboardLayouts);

describe(`the layout in use`, () => {
    it(`is called by the system's name for it, else the layout's, else its code`, () => {
        expect(keyboardNameOf(example(GOLDEN.keyboardStatus, 0), layouts)).toBe(`German (no dead keys)`);
        expect(keyboardNameOf({ layout: `de`, variant: `nodeadkeys`, name: null }, layouts)).toBe(`German (no dead keys)`);
        expect(keyboardNameOf({ layout: `pl`, variant: null, name: null }, layouts)).toBe(`Polish`);
        expect(keyboardNameOf({ layout: `fr`, variant: null, name: null }, undefined)).toBe(`fr`);
    });
});

describe(`the layouts to pick from`, () => {
    it(`are by name, alphabetically, each by its code`, () => {
        expect(layoutOptionsOf(layouts)).toEqual([
            { value: `us`, label: `English (US)` },
            { value: `de`, label: `German` },
            { value: `pl`, label: `Polish` },
        ]);
    });

    it(`each offers its variants after its own, and nothing where it has none`, () => {
        expect(variantOptionsOf(layoutOf(layouts, `us`), `Standard`)).toEqual([
            { value: STANDARD, label: `Standard` },
            { value: `dvorak`, label: `English (Dvorak)` },
            { value: `intl`, label: `English (US, intl., with dead keys)` },
        ]);
        expect(variantOptionsOf(layoutOf(layouts, `pl`), `Standard`)).toEqual([]);
        expect(variantOptionsOf(layoutOf(layouts, `xx`), `Standard`)).toEqual([]);
    });
});
