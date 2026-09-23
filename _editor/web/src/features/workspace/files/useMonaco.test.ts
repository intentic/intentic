const highlighter = { ensureLang: jest.fn() };
const diagnostics = { reportClient: jest.fn(), describeError: jest.fn(() => ({ message: `boom`, fields: {} })) };
const appUpdate = { reportIncompleteBundle: jest.fn() };

// Listed by hand rather than spread over the barrel: pulling it in here would cost mermaid, shiki and vue-flow.
jest.mock("@intentic/ui", () => ({
    useHighlighter: () => highlighter,
    useTheme: () => ({ scheme: { value: `light` } }),
}));

// The editors' type follows the app's base text size, and their colours follow the scheme; both are facts about
// a document, and these cases are about grammar registration, so they run without one. Stubbed on the SUBPATHS,
// which is how the modules under test reach them: a plain state module takes the kit's own entry point rather
// than the barrel, so that holding a preference does not drag mermaid, shiki and vue-flow in with it.
jest.mock("@intentic/ui/text-size", () => ({ useTextSize: () => ({ scale: { value: 1 } }) }));
jest.mock("@intentic/ui/theme", () => ({ useTheme: jest.fn() }));
// The two app-wide channels a failure reaches, stubbed because the real ones talk to the daemon and to the
// notification host: what matters here is that a grammar that never arrived reaches both.
jest.mock("../../../app/clientDiagnostics", () => diagnostics);
jest.mock("../../../app/appUpdate", () => appUpdate);

const { useMonaco } = await import("./useMonaco");

const monaco = {
    languages: {
        getLanguages: jest.fn(() => []),
        register: jest.fn(),
    },
};

describe(`ensureLanguage`, () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it(`falls back to plaintext when a lazy grammar chunk fails`, async () => {
        highlighter.ensureLang.mockRejectedValueOnce(new Error(`stale grammar chunk`));

        await expect(useMonaco().ensureLanguage(monaco as never, `markdown`)).resolves.toBeUndefined();
        expect(monaco.languages.register).not.toHaveBeenCalled();
    });

    it(`reports the failure, since plain text is also what a language we ship nothing for looks like`, async () => {
        highlighter.ensureLang.mockRejectedValueOnce(new Error(`stale grammar chunk`));

        await useMonaco().ensureLanguage(monaco as never, `markdown`);

        expect(diagnostics.reportClient).toHaveBeenCalledWith(`editor.grammar-unreachable`, expect.stringContaining(`markdown`), {
            level: `warn`,
            fields: { lang: `markdown` },
        });
    });

    // The browser will not fetch that module again in this document, so reopening the file cannot fix it and the
    // reader is owed the one action that can.
    it(`offers the reload, since nothing in this page can fetch that chunk again`, async () => {
        highlighter.ensureLang.mockRejectedValueOnce(new Error(`stale grammar chunk`));

        await useMonaco().ensureLanguage(monaco as never, `markdown`);

        expect(appUpdate.reportIncompleteBundle).toHaveBeenCalledTimes(1);
    });

    it(`keeps quiet about a language it ships no grammar for, which is not a failure`, async () => {
        highlighter.ensureLang.mockResolvedValueOnce(undefined);

        await expect(useMonaco().ensureLanguage(monaco as never, `cuneiform`)).resolves.toBeUndefined();
        expect(diagnostics.reportClient).not.toHaveBeenCalled();
        expect(appUpdate.reportIncompleteBundle).not.toHaveBeenCalled();
    });
});
