import { expect, test } from "vitest";
import { type QuickModelSource, quickModelKey, resolveQuickModel } from "./quick-model.js";

/* Which model a one-click helper spends. The rule answers two surfaces at once — the daemon runs it, the
 * browser names it in the sparkle's tooltip — so what these tests pin is that a sandbox's connections alone
 * decide it, with no stored id to go stale. */

// Catalogs as their providers actually publish them: Claude's ranked list, the rest in registry order.
const CLAUDE: QuickModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`] };
const GOOGLE: QuickModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3-pro`] };
const CODEX: QuickModelSource = { provider: `codex`, ready: true, models: [`gpt-5.4-mini`, `gpt-5.6`] };
const KIMI: QuickModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2-0711-preview`, `kimi-k2-0905-preview`] };

const offline = (source: QuickModelSource): QuickModelSource => ({ ...source, ready: false });

test("reaches for the efficient rung of the one connected provider, never its flagship", () => {
    expect(resolveQuickModel([CLAUDE], ``)).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("spends the FREE channel over the subscription when both offer the same rung", () => {
    // Both publish a cheap-tier row, so nothing separates them on capability — and one of them costs the user
    // nothing while the other eats headroom they watch. Clicking sparkle should not quietly bill the Claude plan.
    expect(resolveQuickModel([CLAUDE, GOOGLE], ``)).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite` });
});

test("puts tier ahead of cost — a free frontier model is still the wrong tool for a commit message", () => {
    // Google connected but publishing only its Pro line. Ordering on price first would seat a flagship here,
    // which is the exact outcome the feature exists to avoid.
    const proOnly: QuickModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-pro`] };

    expect(resolveQuickModel([CLAUDE, proOnly], ``)).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("prefers a subscription to a metered key at equal tier, since only one of them charges per click", () => {
    const kimiCheap: QuickModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2-mini`] };
    const claudeCheap: QuickModelSource = { provider: `claude`, ready: true, models: [`claude-haiku-4-5`] };

    expect(resolveQuickModel([kimiCheap, claudeCheap], ``)?.provider).toBe(`claude`);
});

test("answers the same thing however the connected providers happen to be listed", () => {
    // The daemon assembles these from live stores and the browser from its own refs; neither order is a fact.
    const answers = [
        resolveQuickModel([CLAUDE, GOOGLE, CODEX], ``),
        resolveQuickModel([CODEX, CLAUDE, GOOGLE], ``),
        resolveQuickModel([GOOGLE, CODEX, CLAUDE], ``),
    ];

    expect(new Set(answers.map((answer) => quickModelKey(answer!))).size).toBe(1);
});

test("honours a pinned model verbatim, including an id no catalog lists yet", () => {
    expect(resolveQuickModel([CLAUDE, GOOGLE], `claude:claude-opus-5`)).toEqual({ provider: `claude`, model: `claude-opus-5` });
    // The picker's custom-id escape hatch reaches here too: a catalog can lag a release, and running something
    // other than what the settings row names would be the worse failure.
    expect(resolveQuickModel([CLAUDE], `claude:claude-haiku-9`)).toEqual({ provider: `claude`, model: `claude-haiku-9` });
});

test("falls back to Auto when the pinned provider is no longer connected", () => {
    // Rather than failing every click with a credential error while the sandbox can plainly still answer.
    expect(resolveQuickModel([offline(CLAUDE), GOOGLE], `claude:claude-haiku-4-5-20251001`)).toEqual({
        provider: `gemini`,
        model: `gemini-3-flash-lite`,
    });
});

test("ignores a malformed pin instead of running an empty model id", () => {
    for (const pinned of [`claude`, `claude:`, `:claude-haiku-4-5`, ` `]) {
        expect(resolveQuickModel([CLAUDE], pinned)).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
    }
});

test("serves the newest of a catalog that publishes no cheap tier at all", () => {
    // Kimi names no tier word anywhere. There is no cheaper rung to find, so the newest row is the honest answer.
    expect(resolveQuickModel([KIMI], ``)).toEqual({ provider: `kimi`, model: `kimi-k2-0905-preview` });
});

test("reports nothing when no account is connected, so the button can say so instead of failing on click", () => {
    expect(resolveQuickModel([offline(CLAUDE), offline(GOOGLE)], ``)).toBeUndefined();
    expect(resolveQuickModel([], `claude:claude-haiku-4-5`)).toBeUndefined();
});

test("skips a connected provider whose catalog has not loaded yet", () => {
    const unloaded: QuickModelSource = { provider: `grok`, ready: true, models: [] };

    expect(resolveQuickModel([unloaded, CLAUDE], ``)).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
    expect(resolveQuickModel([unloaded], ``)).toBeUndefined();
});
