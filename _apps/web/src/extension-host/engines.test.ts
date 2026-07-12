import { describe, expect, it } from "vitest";
import { satisfiesEngines } from "./engines";

describe(`satisfiesEngines`, () => {
    it(`caret on 0.x treats the minor as breaking`, () => {
        expect(satisfiesEngines(`^0.1`, `0.1.0`)).toBe(true);
        expect(satisfiesEngines(`^0.1`, `0.1.7`)).toBe(true);
        expect(satisfiesEngines(`^0.1`, `0.2.0`)).toBe(false);
        expect(satisfiesEngines(`^0.1.3`, `0.1.2`)).toBe(false);
    });

    it(`caret on 1+ pins the major and floors minor.patch`, () => {
        expect(satisfiesEngines(`^1`, `1.4.2`)).toBe(true);
        expect(satisfiesEngines(`^1.2`, `1.1.9`)).toBe(false);
        expect(satisfiesEngines(`^1.2.3`, `1.2.3`)).toBe(true);
        expect(satisfiesEngines(`^1`, `2.0.0`)).toBe(false);
    });

    it(`a bare version is exact`, () => {
        expect(satisfiesEngines(`0.1.0`, `0.1.0`)).toBe(true);
        expect(satisfiesEngines(`0.1.0`, `0.1.1`)).toBe(false);
    });

    it(`garbage fails closed`, () => {
        expect(satisfiesEngines(`latest`, `0.1.0`)).toBe(false);
        expect(satisfiesEngines(`>=0.1`, `0.1.0`)).toBe(false);
        expect(satisfiesEngines(``, `0.1.0`)).toBe(false);
    });
});
