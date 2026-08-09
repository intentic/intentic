import { describe, expect, it } from "vitest";
import { linkFields, slugify, wikiLink } from "./note-shape.js";

describe(`linkFields`, () => {
    it(`turns rel=target into a header field the graph can actually see`, () => {
        expect(Object.fromEntries(linkFields([`works_on=Intentic`]))).toEqual({ works_on: [`[[Intentic]]`] });
    });

    it(`gathers several targets under one relationship`, () => {
        expect(Object.fromEntries(linkFields([`works_on=Intentic`, `works_on=iq`]))).toEqual({ works_on: [`[[Intentic]]`, `[[iq]]`] });
    });

    it(`leaves a target that was already written as a link alone`, () => {
        expect(Object.fromEntries(linkFields([`works_on=[[Intentic]]`]))).toEqual({ works_on: [`[[Intentic]]`] });
    });

    it(`keeps a target containing an equals sign whole`, () => {
        expect(Object.fromEntries(linkFields([`about=a=b`]))).toEqual({ about: [`[[a=b]]`] });
    });

    it(`ignores a pair with nothing on one side of it`, () => {
        expect([...linkFields([`works_on=`, `=Intentic`, `nonsense`])]).toEqual([]);
    });
});

describe(`slugify`, () => {
    it(`makes a filename out of a title`, () => {
        expect(slugify(`Ada Lovelace`)).toBe(`ada-lovelace`);
        expect(slugify(`Why extensions?`)).toBe(`why-extensions`);
        expect(slugify(`  spaced   out  `)).toBe(`spaced-out`);
    });

    it(`never answers with something that is not a usable filename`, () => {
        expect(slugify(`???`)).toBe(`note`);
        expect(slugify(``)).toBe(`note`);
        expect(slugify(`../../etc/passwd`)).toBe(`etcpasswd`);
    });
});

describe(`wikiLink`, () => {
    it(`brackets a bare name and leaves a bracketed one`, () => {
        expect(wikiLink(`Intentic`)).toBe(`[[Intentic]]`);
        expect(wikiLink(`[[Intentic]]`)).toBe(`[[Intentic]]`);
    });
});
