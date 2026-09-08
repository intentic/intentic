// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import DOMPurify from "dompurify";
import { createIconRegistry, type SvgIconPack } from "mermaid/dist/rendering-util/svgIcons.mjs";

const pack: SvgIconPack = {
    prefix: `test`,
    width: 24,
    height: 12,
    icons: {
        mark: { body: `<path d="M2 2h20v8H2Z"/>` },
        clipped: { body: `<defs><clipPath id="cut"><path d="M2 2h20v8H2Z"/></clipPath></defs><path clip-path="url(#cut)" d="M0 0h24v12H0Z"/>` },
    },
    aliases: { turned: { parent: `mark`, rotate: 1 }, cycle: { parent: `cycle` } },
};
const parse = (text: string): SVGElement => new DOMParser().parseFromString(text, `image/svg+xml`).documentElement as unknown as SVGElement;

it(`preserves a rectangular icon's proportions and rotated view box`, async () => {
    const registry = createIconRegistry((svg) => svg);
    registry.registerIconPacks([{ name: `test`, icons: pack }]);
    const ordinary = parse(await registry.getIconSVG(`test:mark`, { height: 16 }));
    expect([ordinary.getAttribute(`width`), ordinary.getAttribute(`height`), ordinary.getAttribute(`viewBox`)]).toEqual([`32`, `16`, `0 0 24 12`]);
    const turned = parse(await registry.getIconSVG(`test:turned`, { width: 16 }));
    expect([turned.getAttribute(`width`), turned.getAttribute(`height`), turned.getAttribute(`viewBox`)]).toEqual([`16`, `32`, `0 0 12 24`]);
    expect(turned.querySelector(`g`)?.getAttribute(`transform`)).toContain(`rotate(90)`);
});

it(`gives repeated SVG definitions distinct IDs and updates their references`, async () => {
    const registry = createIconRegistry((svg) => svg);
    registry.registerIconPacks([{ name: `test`, icons: pack }]);
    const first = parse(await registry.getIconSVG(`test:clipped`));
    const second = parse(await registry.getIconSVG(`test:clipped`));
    const ids = [first, second].map((svg) => svg.querySelector(`clipPath`)!.id);
    expect(new Set(ids).size).toBe(2);
    for (const [index, svg] of [first, second].entries()) {
        expect(svg.querySelector(`path[clip-path]`)?.getAttribute(`clip-path`)).toBe(`url(#${ids[index]})`);
    }
});

it(`shares an asynchronous loader and rejects unknown or cyclic names`, async () => {
    const registry = createIconRegistry((svg) => svg);
    const loader = vi.fn(async () => pack);
    registry.registerIconPacks([{ name: `test`, loader }]);
    expect(await Promise.all([registry.isIconAvailable(`test:mark`), registry.isIconAvailable(`test:turned`)])).toEqual([true, true]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await registry.isIconAvailable(`test:cycle`)).toBe(false);
    expect(await registry.isIconAvailable(`test:constructor`)).toBe(false);
    expect(await registry.isIconAvailable(`missing:mark`)).toBe(false);
});

it(`sanitizes artwork before returning diagram markup`, async () => {
    const registry = createIconRegistry((svg) => DOMPurify.sanitize(svg));
    registry.registerIconPacks([
        { name: `unsafe`, icons: { prefix: `unsafe`, icons: { mark: { body: `<script>alert(1)</script><path onload="alert(1)" d="M2 2h20"/>` } } } },
    ]);
    const svg = parse(await registry.getIconSVG(`unsafe:mark`));
    expect(svg.querySelector(`script`)).toBeNull();
    expect(svg.querySelector(`[onload]`)).toBeNull();
    expect(svg.querySelector(`path`)?.getAttribute(`d`)).toBe(`M2 2h20`);
});
