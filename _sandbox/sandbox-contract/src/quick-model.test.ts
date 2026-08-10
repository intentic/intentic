import { expect, test } from "vitest";
import { type QuickModelChoice, type QuickModelSource, quickModelKey, resolveQuickModels } from "./quick-model.js";

/* Which models a small automatic helper spends, and in which order. The rule answers two surfaces at once —
 * the daemon walks it, the browser names its head in the settings row — so what these tests pin is that a
 * sandbox's connections alone decide it, with no stored id to go stale, and that there is always a rung
 * underneath the first one whenever the sandbox has another account to reach for. */

// Catalogs as their providers actually publish them: Claude's ranked list, the rest in registry order.
const CLAUDE: QuickModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`] };
const GOOGLE: QuickModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3-pro`] };
const CODEX: QuickModelSource = { provider: `codex`, ready: true, models: [`gpt-5.4-mini`, `gpt-5.6`] };
const KIMI: QuickModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`] };

const offline = (source: QuickModelSource): QuickModelSource => ({ ...source, ready: false });

// The model that answers when nothing goes wrong — the head of the chain, which is what most of what follows is
// about and what every surface naming the spend up front reads.
const head = (sources: readonly QuickModelSource[], pinned: readonly string[]): QuickModelChoice | undefined =>
    resolveQuickModels(sources, pinned)[0];

test("reaches for the efficient rung of the one connected provider, never its flagship", () => {
    expect(head([CLAUDE], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("spends the FREE channel over the subscription when both offer the same rung", () => {
    // Both publish a cheap-tier row, so nothing separates them on capability — and one of them costs the user
    // nothing while the other eats headroom they watch. A background helper should not quietly bill the Claude plan.
    expect(head([CLAUDE, GOOGLE], [])).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite` });
});

test("puts tier ahead of cost — a free frontier model is still the wrong tool for a commit message", () => {
    // Google connected but publishing only its Pro line. Ordering on price first would seat a flagship here,
    // which is the exact outcome the feature exists to avoid.
    const proOnly: QuickModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-pro`] };

    expect(head([CLAUDE, proOnly], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("uses stable provider order when two subscriptions offer the same tier", () => {
    const kimiCheap: QuickModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2-mini`] };
    const claudeCheap: QuickModelSource = { provider: `claude`, ready: true, models: [`claude-haiku-4-5`] };

    expect(head([kimiCheap, claudeCheap], [])?.provider).toBe(`claude`);
});

test("answers the same thing however the connected providers happen to be listed", () => {
    // The daemon assembles these from live stores and the browser from its own refs; neither order is a fact.
    const answers = [head([CLAUDE, GOOGLE, CODEX], []), head([CODEX, CLAUDE, GOOGLE], []), head([GOOGLE, CODEX, CLAUDE], [])];

    expect(new Set(answers.map((answer) => quickModelKey(answer!))).size).toBe(1);
});

test("honours a pinned model verbatim, including an id no catalog lists yet", () => {
    expect(head([CLAUDE, GOOGLE], [`claude:claude-opus-5`])).toEqual({ provider: `claude`, model: `claude-opus-5` });
    // The picker's custom-id escape hatch reaches here too: a catalog can lag a release, and running something
    // other than what the settings row names would be the worse failure.
    expect(head([CLAUDE], [`claude:claude-haiku-9`])).toEqual({ provider: `claude`, model: `claude-haiku-9` });
});

test("falls back to Auto when the pinned provider is no longer connected", () => {
    // Rather than failing every click with a credential error while the sandbox can plainly still answer.
    expect(head([offline(CLAUDE), GOOGLE], [`claude:claude-haiku-4-5-20251001`])).toEqual({
        provider: `gemini`,
        model: `gemini-3-flash-lite`,
    });
});

test("ignores a malformed pin instead of running an empty model id", () => {
    for (const pinned of [`claude`, `claude:`, `:claude-haiku-4-5`, ` `]) {
        expect(head([CLAUDE], [pinned])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
    }
});

test("serves the newest of a catalog that publishes no cheap tier at all", () => {
    // Kimi names no tier word anywhere. There is no cheaper rung to find, so the newest row is the honest answer.
    expect(head([KIMI], [])).toEqual({ provider: `kimi`, model: `kimi-k3` });
});

test("reports nothing when no account is connected, so the button can say so instead of failing on click", () => {
    expect(head([offline(CLAUDE), offline(GOOGLE)], [])).toBeUndefined();
    expect(resolveQuickModels([offline(CLAUDE), offline(GOOGLE)], [])).toEqual([]);
    expect(head([], [`claude:claude-haiku-4-5`])).toBeUndefined();
});

test("skips a connected provider whose catalog has not loaded yet", () => {
    const unloaded: QuickModelSource = { provider: `grok`, ready: true, models: [] };

    expect(head([unloaded, CLAUDE], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
    expect(head([unloaded], [])).toBeUndefined();
});

/* THE CHAIN — what the daemon walks when the model at the top of it refuses. A spent allowance is the ordinary
 * case, not the exotic one: the account a helper shares with the chat runs out mid-afternoon, and the whole
 * point of the list is that the click still lands on the next rung down. */

test("keeps the pinned models in the order they were written", () => {
    expect(resolveQuickModels([CLAUDE, GOOGLE, CODEX], [`codex:gpt-5.6`, `gemini:gemini-3-flash`, `claude:claude-haiku-4-5-20251001`])).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `gemini`, model: `gemini-3-flash` },
        { provider: `claude`, model: `claude-haiku-4-5-20251001` },
    ]);
});

test("drops a pin whose provider went away and keeps the rest of the order intact", () => {
    expect(resolveQuickModels([CLAUDE, offline(GOOGLE), CODEX], [`codex:gpt-5.6`, `gemini:gemini-3-flash`, `claude:claude-haiku-4-5`])).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

test("stops at the end of a pinned list rather than reaching for an account the user left out", () => {
    // Google and Kimi are connected and cheaper. The user wrote down one model, so one model is what this may
    // spend — a pin exists precisely to keep a helper off the accounts it does not name.
    expect(resolveQuickModels([CLAUDE, GOOGLE, KIMI], [`claude:claude-haiku-4-5`])).toEqual([{ provider: `claude`, model: `claude-haiku-4-5` }]);
});

test("names each model once, however many times the list repeats it", () => {
    // The list is edited by hand; a duplicate would spend a second attempt proving the same account is out.
    expect(resolveQuickModels([CLAUDE], [`claude:claude-haiku-4-5`, `claude:claude-haiku-4-5`])).toEqual([
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

test("Auto is a ladder too — every connected provider's cheap rung, best first", () => {
    expect(resolveQuickModels([CLAUDE, GOOGLE, KIMI], [])).toEqual([
        { provider: `gemini`, model: `gemini-3-flash-lite` },
        { provider: `claude`, model: `claude-haiku-4-5-20251001` },
        { provider: `kimi`, model: `kimi-k3` },
    ]);
});

/* A MODEL ENDPOINT the user configured is a provider like any other here, and the reason it has to be is the
 * settings row: its options are built from the same picker catalog, so a pin naming one that this resolver
 * dropped would print one model's name in the settings row and spend a different account entirely. */
const OLLAMA: QuickModelSource = { provider: `endpoint/ollama`, ready: true, models: [`qwen3-coder`, `gemma3-27b`] };

test("honours a pin on a configured endpoint — the whole id, not the half before its slash", () => {
    expect(head([CLAUDE, OLLAMA], [`endpoint/ollama:qwen3-coder`])).toEqual({ provider: `endpoint/ollama`, model: `qwen3-coder` });
    // And it round-trips through the key shape the picker mints, which is where the slash-not-colon rule earns
    // itself: parsePinned splits on the FIRST colon, so an `endpoint:ollama` id would have parsed the provider
    // as "endpoint" and the model as "ollama:qwen3-coder" — a pin that silently resolves to nothing.
    expect(quickModelKey({ provider: `endpoint/ollama`, model: `qwen3-coder` })).toBe(`endpoint/ollama:qwen3-coder`);
});

test("leaves Auto to the providers whose price is known, rather than reaching for someone's own server", () => {
    // Claude publishes a Haiku-class row; the endpoint's ids carry no tier word at all, so they are UNRANKED and
    // lose on tier. What a turn on a user's own model API costs is not a fact this repo holds, and Auto should
    // not be asserting one.
    expect(head([CLAUDE, OLLAMA], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("still answers from an endpoint when it is the only thing configured", () => {
    // No tier word in either id, so the shared id-derived ordering decides between them exactly as it does for
    // Kimi above — the point here is that a sandbox whose only model API is its owner's still gets an answer
    // rather than the disabled "nothing connected" button.
    expect(head([offline(CLAUDE), OLLAMA], [])).toEqual({ provider: `endpoint/ollama`, model: `qwen3-coder` });
});
