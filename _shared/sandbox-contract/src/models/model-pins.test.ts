import { expect, test } from "vitest";
import { type ModelSource, modelPinKey, parsePinned, readyChain } from "./model-pins.js";
import type { ModelPin } from "../schemas/agent.js";

// Which models a job spends, and in what order: the owner's own list decides, nothing is derived for an empty one, and
// there is a fallback rung whenever one is written.

// A pin as settings rows store one; tests focus on order, so most entries carry just provider:model.
const pin = (key: string): ModelPin => {
    const at = key.indexOf(`:`);
    return { provider: key.slice(0, at), model: key.slice(at + 1) };
};

// Catalogs as providers publish them; the resolver never reads them, so a wrong fixture would hide it.
const CLAUDE: ModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`] };
const GOOGLE: ModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3-pro`] };
const CODEX: ModelSource = { provider: `codex`, ready: true, models: [`gpt-5.4-mini`, `gpt-5.6`] };
const KIMI: ModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`] };

const offline = (source: ModelSource): ModelSource => ({ ...source, ready: false });

// The model that answers when nothing goes wrong: the head of the chain, what every surface reads.
const head = (sources: readonly ModelSource[], pinned: readonly string[]): ModelPin | undefined => readyChain(sources, pinned.map(pin))[0];

test("honours a pinned model verbatim, including an id no catalog lists yet", () => {
    expect(head([CLAUDE, GOOGLE], [`claude:claude-opus-5`])).toEqual({ provider: `claude`, model: `claude-opus-5` });
    // The picker's custom-id escape hatch reaches here too: a lagging catalog still must run the exact id named.
    expect(head([CLAUDE], [`claude:claude-haiku-9`])).toEqual({ provider: `claude`, model: `claude-haiku-9` });
});

test("refuses a malformed key rather than reading half a pin out of it", () => {
    for (const key of [`claude`, `claude:`, `:claude-haiku-4-5`, ` `]) {
        expect(parsePinned(key)).toBeUndefined();
    }
    expect(parsePinned(`claude:claude-haiku-4-5`)).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
});

test("resolves an unset job to nothing, however many accounts are connected", () => {
    expect(readyChain([CLAUDE, GOOGLE, KIMI], [])).toEqual([]);
    expect(head([CLAUDE, GOOGLE], [])).toBeUndefined();
});

test("carries an entry's run settings through untouched", () => {
    const configured: ModelPin = { provider: `claude`, model: `claude-opus-5`, effort: `max`, thinking: true, harness: `claude-code` };

    expect(readyChain([CLAUDE], [configured])).toEqual([configured]);
});

test("reports nothing when the accounts a job named have all gone", () => {
    expect(head([offline(CLAUDE), GOOGLE], [`claude:claude-haiku-4-5-20251001`])).toBeUndefined();
    expect(head([], [`claude:claude-haiku-4-5`])).toBeUndefined();
});

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
    expect(readyChain([CLAUDE, GOOGLE, KIMI], [`claude:claude-haiku-4-5`].map(pin))).toEqual([{ provider: `claude`, model: `claude-haiku-4-5` }]);
});

test("names each model once, however many times the list repeats it", () => {
    // A duplicate pin is a real state (hand-edited lists, one entry reused across jobs), not a bug to collapse.
    expect(readyChain([CLAUDE], [`claude:claude-haiku-4-5`, `claude:claude-haiku-4-5`].map(pin))).toEqual([
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

// A configured endpoint is a provider like any other here: its picker options come from the same catalog.
const OLLAMA: ModelSource = { provider: `endpoint/ollama`, ready: true, models: [`qwen3-coder`, `gemma3-27b`] };

test("honours a pin on a configured endpoint: the whole id, not the half before its slash", () => {
    expect(head([CLAUDE, OLLAMA], [`endpoint/ollama:qwen3-coder`])).toEqual({ provider: `endpoint/ollama`, model: `qwen3-coder` });
    // parsePinned splits on the first colon; an id with its own colon needs the slash form or parsing breaks.
    expect(modelPinKey({ provider: `endpoint/ollama`, model: `qwen3-coder` })).toBe(`endpoint/ollama:qwen3-coder`);
});
