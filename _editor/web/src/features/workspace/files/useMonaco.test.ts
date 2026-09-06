import { beforeEach, describe, expect, it, vi } from "vitest";

const highlighter = vi.hoisted(() => ({ ensureLang: vi.fn() }));

vi.mock("@intentic/ui", () => ({
    useHighlighter: () => highlighter,
}));

// The editors' type follows the app's base text size, and their colours follow the scheme; both are facts about
// a document, and these cases are about grammar registration, so they run without one. Stubbed on the SUBPATHS,
// which is how the modules under test reach them: a plain state module takes the kit's own entry point rather
// than the barrel, so that holding a preference does not drag mermaid, shiki and vue-flow in with it.
vi.mock("@intentic/ui/text-size", () => ({ useTextSize: () => ({ scale: { value: 1 } }) }));
vi.mock("@intentic/ui/theme", () => ({ useTheme: vi.fn() }));

const { useMonaco } = await import("./useMonaco");

const monaco = {
    languages: {
        getLanguages: vi.fn(() => []),
        register: vi.fn(),
    },
};

describe(`ensureLanguage`, () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it(`falls back to plaintext when a lazy grammar chunk fails`, async () => {
        highlighter.ensureLang.mockRejectedValueOnce(new Error(`stale grammar chunk`));

        await expect(useMonaco().ensureLanguage(monaco as never, `markdown`)).resolves.toBeUndefined();
        expect(monaco.languages.register).not.toHaveBeenCalled();
    });
});
