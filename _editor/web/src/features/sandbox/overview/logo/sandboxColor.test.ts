import { SWATCHES, swatchHex } from "@intentic/ui";
import { logoStyleImage } from "./presets";
import { sandboxColor } from "./sandboxColor";

const swatch = (key: string): string => swatchHex(SWATCHES.find((entry) => entry.key === key)!);
const teal = swatch(`teal`);
const clay = swatch(`clay`);
const hued = new Set(SWATCHES.filter((entry) => entry.key !== `stone`).map(swatchHex));

it(`paints a sandbox in its owner's pick, over its logo's colour`, () => {
    expect(sandboxColor({ id: `a`, color: teal, image: logoStyleImage({ icon: `box`, color: clay }) })).toBe(teal);
});

it(`takes a preset logo's colour while nobody has picked one, so a sandbox someone already styled keeps its colour`, () => {
    expect(sandboxColor({ id: `a`, color: null, image: logoStyleImage({ icon: `box`, color: clay }) })).toBe(clay);
});

it(`lands any stored colour on the nearest swatch, so the picker can say which one is worn`, () => {
    const swatches = new Set(SWATCHES.map(swatchHex));
    for (const stored of [`#00FFFF`, `#7c9b8b`, `#a395b3`, `#123456`, `#e5484d`]) {
        expect(swatches.has(sandboxColor({ id: `a`, color: stored }))).toBe(true);
    }
    expect(sandboxColor({ id: `a`, color: `#e5484d` })).not.toBe(teal);
    expect(sandboxColor({ id: `a`, color: teal })).toBe(teal);
    // A grey with a cast is stone, not whichever hue the cast leans to.
    expect(sandboxColor({ id: `a`, color: `#8a8d91` })).toBe(swatch(`stone`));
});

// The palette before 2026-11-24 (one chroma for every hue), as rows saved then still carry it: each lands on its
// neighbour in the earth palette, so nobody's sandbox changes family.
it(`wears a colour saved from the old palette as its nearest earth pigment`, () => {
    const moved: readonly (readonly [string, string])[] = [
        [`#6a98d2`, `slate`], // cobalt
        [`#948acf`, `slate`], // iris
        [`#3ba5bc`, `teal`], // lagoon
        [`#45a992`, `teal`], // emerald
        [`#b87eb3`, `plum`], // orchid
        [`#ca7b87`, `clay`], // rose
        [`#ad9247`, `ochre`], // brass
        [`#8c96a1`, `stone`], // graphite
    ];
    for (const [stored, key] of moved) {
        expect(sandboxColor({ id: `a`, color: stored })).toBe(swatch(key));
    }
});

it(`derives a hued swatch from the id for a sandbox with neither, the same one every time`, () => {
    const first = sandboxColor({ id: `cm3xk2p0a0001`, color: null, image: `data:image/webp;base64,UPLOADED` });
    expect(hued.has(first)).toBe(true);
    expect(sandboxColor({ id: `cm3xk2p0a0001` })).toBe(first);
});

it(`reads a malformed stored colour as none rather than painting it`, () => {
    expect(sandboxColor({ id: `cm3xk2p0a0001`, color: `teal` })).toBe(sandboxColor({ id: `cm3xk2p0a0001` }));
});

it(`spreads ids across the swatches rather than landing them all on one`, () => {
    const seen = new Set(Array.from({ length: 40 }, (_, index) => sandboxColor({ id: `sandbox-${index}` })));
    expect(seen.size).toBeGreaterThan(5);
});
