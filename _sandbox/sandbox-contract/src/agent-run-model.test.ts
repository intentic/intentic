import { expect, test } from "vitest";
import { resolveAgentRunModels } from "./agent-run-model.js";
import type { QuickModelSource } from "./quick-model.js";

/* Which model a run somebody's BUTTON started opens on. The rule answers the same two surfaces its quick-model
 * sibling does — the daemon walks it, the settings row names it — so what these pin is the pair of properties
 * that separate the two: an account this sandbox cannot reach never sits at the head of the chain, and an empty
 * answer stays empty rather than being filled in with a tier nobody chose. */

const CLAUDE: QuickModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`] };
const CODEX: QuickModelSource = { provider: `codex`, ready: true, models: [`gpt-5.6`] };
const GOOGLE: QuickModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-pro`] };

const offline = (source: QuickModelSource): QuickModelSource => ({ ...source, ready: false });

test("keeps the user's own order — this list is read, never ranked", () => {
    // The opposite of the quick chain, which sorts by tier and cost. Here the order IS the setting: someone who
    // put Opus above GPT wants Opus first, and a resolver that knew better would spend the wrong account.
    expect(resolveAgentRunModels([CLAUDE, CODEX], [`codex:gpt-5.6`, `claude:claude-opus-5`])).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `claude`, model: `claude-opus-5` },
    ]);
});

test("steps over a provider this sandbox has no credential for", () => {
    // The whole reason the setting is a list. With Claude disconnected the head would otherwise be an account
    // that fails every Fix with agent, while a perfectly good Codex sits underneath it.
    expect(resolveAgentRunModels([offline(CLAUDE), CODEX], [`claude:claude-opus-5`, `codex:gpt-5.6`])).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
    ]);
});

test("resolves to nothing when no pin is reachable — it does NOT fall back to whatever is connected", () => {
    // The deliberate difference from resolveQuickModels, which lands on its Auto ladder here. An agent run is
    // billed in whole sessions, so an unreachable list hands the choice back to the caller's floor (the user's
    // own composer pick) rather than spending an account they never pointed at.
    expect(resolveAgentRunModels([offline(CLAUDE), GOOGLE], [`claude:claude-opus-5`])).toEqual([]);
});

test("an empty list resolves to nothing even with accounts connected", () => {
    expect(resolveAgentRunModels([CLAUDE, CODEX, GOOGLE], [])).toEqual([]);
});

test("drops a duplicate rather than spending two attempts proving one account is out", () => {
    expect(resolveAgentRunModels([CLAUDE], [`claude:claude-opus-5`, `claude:claude-opus-5`])).toEqual([
        { provider: `claude`, model: `claude-opus-5` },
    ]);
});

test("drops a malformed key instead of sending it to a provider", () => {
    expect(resolveAgentRunModels([CLAUDE], [`claude-opus-5`, `claude:`, `:claude-opus-5`, `claude:claude-sonnet-5`])).toEqual([
        { provider: `claude`, model: `claude-sonnet-5` },
    ]);
});

test("carries a model id the static catalog has never heard of", () => {
    // The picker offers a custom-id escape hatch, so a pin can name a model released after this build. Second-
    // guessing it here would quietly run something other than what the settings row says.
    expect(resolveAgentRunModels([CLAUDE], [`claude:claude-opus-9-preview`])).toEqual([
        { provider: `claude`, model: `claude-opus-9-preview` },
    ]);
});
