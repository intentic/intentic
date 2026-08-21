import { beforeEach, describe, expect, it, vi } from "vitest";

const highlighter = vi.hoisted(() => ({ ensureLang: vi.fn() }));

vi.mock("@intentic/ui", () => ({
    useHighlighter: () => highlighter,
    useTheme: vi.fn(),
}));

// The editors' type follows the app's base text size, which is a fact about a document, and these cases are
// about grammar registration, so they run without one. Stubbed for the same reason useTheme above is.
vi.mock("@intentic/ui/text-size", () => ({ useTextSize: () => ({ scale: { value: 1 } }) }));

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
