import { resetSandboxScope } from "@intentic/extension-api";
import type { WorkspaceDerived } from "@intentic/sandbox-contract";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// The rpc client builds a link at import time, so the daemon call is the seam: the predicates are pure, and what the
// module remembers is asserted through it.
const derived = jest.fn();
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ workspace: { derived, derive: jest.fn() } }) }));

const { derivedIsOnlyView, mayHaveDerivedText, readDerivedText } = await import("./derivedText");
const { rememberedDerivedText } = await import("./derivedCache");

const STOPPED = { enabled: false, queued: 0, deriving: [], sweeping: false, broken: false };
const shadow = (path: string, content: string): WorkspaceDerived => ({
    present: true,
    path,
    content,
    deriver: `docx v1`,
    notes: [],
    tokens: 10,
    truncated: false,
    stale: false,
    state: `idle`,
    queue: STOPPED,
});

describe("what a tab remembers of the shadows it has read", () => {
    beforeEach(() => {
        resetSandboxScope();
        derived.mockReset();
    });

    // The point of the whole cache: the second open of a file has an answer before the daemon is asked for one, so
    // nothing is rendered again and no spinner claims otherwise.
    test("a read is kept, so the next open has it before the daemon answers", async () => {
        derived.mockResolvedValue(shadow(`docs/spec.docx`, `# Quarterly plan`));
        expect(rememberedDerivedText(`docs/spec.docx`)).toBeUndefined();
        await readDerivedText(`docs/spec.docx`);
        expect(derived).toHaveBeenCalledWith({ path: `docs/spec.docx` });
        expect(rememberedDerivedText(`docs/spec.docx`)?.path).toBe(`docs/spec.docx`);
    });

    // Bounded by bytes: a session that opens a hundred documents must not carry all of them.
    test("the oldest are dropped once the kept text passes the cap", async () => {
        const big = `x`.repeat(1024 * 1024 + 1);
        for (const name of [`a`, `b`, `c`, `d`, `e`]) {
            derived.mockResolvedValue(shadow(`${name}.docx`, big));
            await readDerivedText(`${name}.docx`);
        }
        // Four 1 MiB shadows fill the 4 MiB budget; the fifth read is what pushes the first one out.
        expect(rememberedDerivedText(`a.docx`)).toBeUndefined();
        expect(rememberedDerivedText(`e.docx`)?.path).toBe(`e.docx`);
    });

    // Paths collide across sandboxes, so a remembered shadow would otherwise describe another workspace's file.
    test("switching sandboxes drops all of them", async () => {
        derived.mockResolvedValue(shadow(`docs/spec.docx`, `# Quarterly plan`));
        await readDerivedText(`docs/spec.docx`);
        resetSandboxScope();
        expect(rememberedDerivedText(`docs/spec.docx`)).toBeUndefined();
    });
});

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
