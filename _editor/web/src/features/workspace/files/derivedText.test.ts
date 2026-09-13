import { describe, expect, test, vi } from "vitest";

// The rpc client builds a link at import time; only the two pure predicates are under test here.
vi.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: { workspace: { derived: vi.fn(), derive: vi.fn() } } }));

const { derivedIsOnlyView, mayHaveDerivedText } = await import("./derivedText");

describe("which files are worth offering a derived reading of", () => {
    test("formats that need rendering are, whichever surface they opened on", () => {
        expect(mayHaveDerivedText(`docs/spec.pdf`, `viewer`)).toBe(true);
        expect(mayHaveDerivedText(`bundle.zip`, `binary`)).toBe(true);
        expect(mayHaveDerivedText(`scan.tiff`, `too-large`)).toBe(true);
    });

    test("source and prose are not: their own bytes are already the reading", () => {
        expect(mayHaveDerivedText(`src/index.ts`, `code`)).toBe(false);
        expect(mayHaveDerivedText(`README.md`, `markdown`)).toBe(false);
        expect(mayHaveDerivedText(`build.log`, `big-text`)).toBe(false);
    });

    test("a notebook is, since it is JSON to the viewer and unreadable to a person", () => {
        expect(mayHaveDerivedText(`analysis.ipynb`, `code`)).toBe(true);
    });

    test("states with nothing behind them are not", () => {
        expect(mayHaveDerivedText(`empty.pdf`, `empty`)).toBe(false);
        expect(mayHaveDerivedText(`.intentic/secrets/auth/claude.json`, `locked`)).toBe(false);
    });
});

describe("which files open on their text rather than offering it", () => {
    test("the ones with no other surface at all", () => {
        expect(derivedIsOnlyView(`release.tar.gz`, `binary`)).toBe(true);
        expect(derivedIsOnlyView(`huge.pdf`, `too-large`)).toBe(true);
    });

    test("never one that has a viewer or reads as text, which would replace a view that works", () => {
        expect(derivedIsOnlyView(`docs/spec.pdf`, `viewer`)).toBe(false);
        expect(derivedIsOnlyView(`analysis.ipynb`, `code`)).toBe(false);
    });
});
