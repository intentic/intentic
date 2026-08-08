import { beforeEach, describe, expect, it, vi } from "vitest";

const highlighter = vi.hoisted(() => ({ ensureLang: vi.fn() }));

vi.mock("@intentic/ui", () => ({
    useHighlighter: () => highlighter,
    useTheme: vi.fn(),
}));

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
