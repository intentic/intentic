import { expect, test } from "vitest";
import { type ModelSource, modelPinKey, parsePinned, readyChain } from "./model-pins.js";
import type { ModelPin } from "./schemas/agent.js";

/* Which models a job spends, and in which order. The rule answers two surfaces at once: the daemon walks it,
 * the browser names its head in that job's settings row, so what these tests pin is that the OWNER'S OWN LIST
 * decides it and nothing else, and that there is a rung underneath the first one whenever they wrote one.
 *
 * NOTHING IS DERIVED FOR AN EMPTY LIST, and that is the property most of this file used to be about. A `helper`
 * role with no models used to fall to an "Auto ladder" — every connected provider's cheapest row, best-first —
 * so a sandbox nobody had configured still spent an account on commit messages and safety verdicts, on a
 * ranking this package invented and re-ranked whenever an account was connected. Not set now means not set,
 * for every role, and what the caller does with an empty answer is the caller's business: a one-shot does not
 * run, a whole session opens on the owner's own composer pick. */

// A pin as the settings rows store one. The tests are about ORDER, so most of them name only the pair; the
// knobs an entry can carry ride through untouched and are asserted where that matters.
const pin = (key: string): ModelPin => {
    const at = key.indexOf(`:`);
    return { provider: key.slice(0, at), model: key.slice(at + 1) };
};

// Catalogs as their providers actually publish them. The resolver reads none of them — a pin is taken verbatim
// — but a ModelSource carries one, and a fixture that lied about it would hide a resolver that started looking.
const CLAUDE: ModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`] };
const GOOGLE: ModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3-pro`] };
const CODEX: ModelSource = { provider: `codex`, ready: true, models: [`gpt-5.4-mini`, `gpt-5.6`] };
const KIMI: ModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`] };

const offline = (source: ModelSource): ModelSource => ({ ...source, ready: false });

// The model that answers when nothing goes wrong: the head of the chain, which is what every surface naming
// the spend up front reads.
const head = (sources: readonly ModelSource[], pinned: readonly string[]): ModelPin | undefined => readyChain(sources, pinned.map(pin))[0];

test("honours a pinned model verbatim, including an id no catalog lists yet", () => {
    expect(head([CLAUDE, GOOGLE], [`claude:claude-opus-5`])).toEqual({ provider: `claude`, model: `claude-opus-5` });
    // The picker's custom-id escape hatch reaches here too: a catalog can lag a release, and running something
    // other than what the settings row names would be the worse failure.
    expect(head([CLAUDE], [`claude:claude-haiku-9`])).toEqual({ provider: `claude`, model: `claude-haiku-9` });
});

/* A MALFORMED KEY IS REFUSED WHERE KEYS STILL EXIST. A role's list holds PINS, whose two halves are separate
 * fields the schema requires (ModelPinSchema), so "claude with an empty model" is no longer a shape the
 * resolver can be handed — it is rejected at the settings boundary instead. What still travels as a key is
 * `autoFastModels`, so the rule lives with the parser that reads one, and this is where it is pinned. */
test("refuses a malformed key rather than reading half a pin out of it", () => {
    for (const key of [`claude`, `claude:`, `:claude-haiku-4-5`, ` `]) {
        expect(parsePinned(key)).toBeUndefined();
    }
    expect(parsePinned(`claude:claude-haiku-4-5`)).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
});

/* THE CLAIM THIS FILE EXISTS FOR NOW. An unset job resolves to NOTHING however much is connected, and it does
 * so for both kinds of role: a resolver that reached for the cheapest rung here is the whole feature that was
 * removed, and it would come back invisibly — the daemon would simply start spending again and the settings
 * row would look unchanged. */
test("resolves an unset job to nothing, however many accounts are connected", () => {
    expect(readyChain([CLAUDE, GOOGLE, KIMI], [])).toEqual([]);
    expect(head([CLAUDE, GOOGLE], [])).toBeUndefined();
});

test("carries an entry's run settings through untouched", () => {
    // The resolver picks WHICH entry; how that entry runs is the entry's own business and rides along whole,
    // because the turn (or the one-shot) is composed from all of it.
    const configured: ModelPin = { provider: `claude`, model: `claude-opus-5`, effort: `max`, thinking: true, harness: `claude-code` };

    expect(readyChain([CLAUDE], [configured])).toEqual([configured]);
});

test("reports nothing when the accounts a job named have all gone", () => {
    // A live button that fails on click is the failure this prevents: the caller renders the state instead.
    expect(head([offline(CLAUDE), GOOGLE], [`claude:claude-haiku-4-5-20251001`])).toBeUndefined();
    expect(head([], [`claude:claude-haiku-4-5`])).toBeUndefined();
});

/* THE CHAIN: what the daemon walks when the model at the top of it refuses. A spent allowance is the ordinary
 * case, not the exotic one: the account a helper shares with the chat runs out mid-afternoon, and the whole
 * point of the list is that the click still lands on the next rung down. */

test("keeps the pinned models in the order they were written", () => {
    expect(readyChain([CLAUDE, GOOGLE, CODEX], [`codex:gpt-5.6`, `gemini:gemini-3-flash`, `claude:claude-haiku-4-5-20251001`].map(pin))).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `gemini`, model: `gemini-3-flash` },
        { provider: `claude`, model: `claude-haiku-4-5-20251001` },
    ]);
});

test("drops a pin whose provider went away and keeps the rest of the order intact", () => {
    expect(readyChain([CLAUDE, offline(GOOGLE), CODEX], [`codex:gpt-5.6`, `gemini:gemini-3-flash`, `claude:claude-haiku-4-5`].map(pin))).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

test("stops at the end of a pinned list rather than reaching for an account the user left out", () => {
    // Google and Kimi are connected and cheaper. The user wrote down one model, so one model is what this may
    // spend: a pin exists precisely to keep a helper off the accounts it does not name.
    expect(readyChain([CLAUDE, GOOGLE, KIMI], [`claude:claude-haiku-4-5`].map(pin))).toEqual([{ provider: `claude`, model: `claude-haiku-4-5` }]);
});

test("names each model once, however many times the list repeats it", () => {
    // The list is hand-edited and the settings page can write one pin across many jobs, so a duplicate is a
    // real state; unchecked it would spend a second attempt proving the same account is out.
    expect(readyChain([CLAUDE], [`claude:claude-haiku-4-5`, `claude:claude-haiku-4-5`].map(pin))).toEqual([
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

/* A MODEL ENDPOINT the user configured is a provider like any other here, and the reason it has to be is the
 * settings row: its options are built from the same picker catalog, so a pin naming one that this resolver
 * dropped would print one model's name in the settings row and spend a different account entirely. */
const OLLAMA: ModelSource = { provider: `endpoint/ollama`, ready: true, models: [`qwen3-coder`, `gemma3-27b`] };

test("honours a pin on a configured endpoint: the whole id, not the half before its slash", () => {
    expect(head([CLAUDE, OLLAMA], [`endpoint/ollama:qwen3-coder`])).toEqual({ provider: `endpoint/ollama`, model: `qwen3-coder` });
    // And it round-trips through the key shape the picker mints, which is where the slash-not-colon rule earns
    // itself: parsePinned splits on the FIRST colon, so an `endpoint:ollama` id would have parsed the provider
    // as "endpoint" and the model as "ollama:qwen3-coder": a pin that silently resolves to nothing.
    expect(modelPinKey({ provider: `endpoint/ollama`, model: `qwen3-coder` })).toBe(`endpoint/ollama:qwen3-coder`);
});
