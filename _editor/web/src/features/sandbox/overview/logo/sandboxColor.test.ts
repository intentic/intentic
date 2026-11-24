import { SWATCHES, swatchHex } from "@intentic/ui";
import { logoStyleImage } from "./presets";
import { sandboxColor } from "./sandboxColor";

const lagoon = swatchHex(SWATCHES.find((swatch) => swatch.key === `lagoon`)!);
const rose = swatchHex(SWATCHES.find((swatch) => swatch.key === `rose`)!);
const hued = new Set(SWATCHES.filter((swatch) => swatch.key !== `graphite`).map(swatchHex));

it(`paints a sandbox in its owner's pick, over its logo's colour`, () => {
    expect(sandboxColor({ id: `a`, color: lagoon, image: logoStyleImage({ icon: `box`, color: rose }) })).toBe(lagoon);
});

it(`takes a preset logo's colour while nobody has picked one, so a sandbox someone already styled keeps its colour`, () => {
    expect(sandboxColor({ id: `a`, color: null, image: logoStyleImage({ icon: `box`, color: rose }) })).toBe(rose);
});

it(`lands any stored colour on the nearest swatch, so the picker can say which one is worn`, () => {
    const swatches = new Set(SWATCHES.map(swatchHex));
    for (const stored of [`#00FFFF`, `#7c9b8b`, `#a395b3`, `#123456`, `#e5484d`]) {
        expect(swatches.has(sandboxColor({ id: `a`, color: stored }))).toBe(true);
    }
    expect(sandboxColor({ id: `a`, color: `#e5484d` })).not.toBe(lagoon);
    expect(sandboxColor({ id: `a`, color: lagoon })).toBe(lagoon);
    // A grey with a cast is graphite, not whichever hue the cast leans to.
    expect(sandboxColor({ id: `a`, color: `#8a8d91` })).toBe(swatchHex(SWATCHES.find((swatch) => swatch.key === `graphite`)!));
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
