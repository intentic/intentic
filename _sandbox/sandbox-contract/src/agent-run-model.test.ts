import { expect, test } from "vitest";
import { resolveAgentRunModels } from "./agent-run-model.js";
import type { QuickModelSource } from "./quick-model.js";
import type { AgentRunPin } from "./schemas/agent.js";

/* Which model a run somebody's BUTTON started opens on. The rule answers the same two surfaces its quick-model
 * sibling does: the daemon walks it, the settings row names it, so what these pin is the pair of properties
 * that separate the two: an account this sandbox cannot reach never sits at the head of the chain, and an empty
 * answer stays empty rather than being filled in with a tier nobody chose.
 *
 * And one property neither of those covers, new with the pins being objects: an entry's own knobs are the
 * entry's, so what survives the walk is the WHOLE pin. A resolver that handed back the pair inside it would run
 * the fallback at the head's effort, which is a tier that appears nowhere on the user's screen. */

const CLAUDE: QuickModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`] };
const CODEX: QuickModelSource = { provider: `codex`, ready: true, models: [`gpt-5.6`] };
const GOOGLE: QuickModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-pro`] };

const offline = (source: QuickModelSource): QuickModelSource => ({ ...source, ready: false });

const pin = (provider: string, model: string, knobs: Partial<AgentRunPin> = {}): AgentRunPin => ({ provider, model, ...knobs });

test("keeps the user's own order, this list is read, never ranked", () => {
    // The opposite of the quick chain, which sorts by tier and cost. Here the order IS the setting: someone who
    // put Opus above GPT wants Opus first, and a resolver that knew better would spend the wrong account.
    expect(resolveAgentRunModels([CLAUDE, CODEX], [pin(`codex`, `gpt-5.6`), pin(`claude`, `claude-opus-5`)])).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `claude`, model: `claude-opus-5` },
    ]);
});

test("steps over a provider this sandbox has no credential for", () => {
    // The whole reason the setting is a list. With Claude disconnected the head would otherwise be an account
    // that fails every Fix with agent, while a perfectly good Codex sits underneath it.
    expect(resolveAgentRunModels([offline(CLAUDE), CODEX], [pin(`claude`, `claude-opus-5`), pin(`codex`, `gpt-5.6`)])).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
    ]);
});

test("each surviving entry keeps its own knobs, not the head's", () => {
    // The effort used to be one setting beside the list, so a fallback ran at whatever the head was set to. It
    // is now a property of the entry that actually answers, which is the only place it was ever true.
    expect(
        resolveAgentRunModels(
            [offline(CODEX), CLAUDE],
            [pin(`codex`, `gpt-5.6`, { effort: `low` }), pin(`claude`, `claude-opus-5`, { effort: `max`, thinking: true })],
        ),
    ).toEqual([{ provider: `claude`, model: `claude-opus-5`, effort: `max`, thinking: true }]);
});

test("resolves to nothing when no pin is reachable: it does NOT fall back to whatever is connected", () => {
    // The deliberate difference from resolveQuickModels, which lands on its Auto ladder here. An agent run is
    // billed in whole sessions, so an unreachable list hands the choice back to the caller's floor (the user's
    // own composer pick) rather than spending an account they never pointed at.
    expect(resolveAgentRunModels([offline(CLAUDE), GOOGLE], [pin(`claude`, `claude-opus-5`)])).toEqual([]);
});

test("an empty list resolves to nothing even with accounts connected", () => {
    expect(resolveAgentRunModels([CLAUDE, CODEX, GOOGLE], [])).toEqual([]);
});

test("drops a duplicate rather than spending two attempts proving one account is out, and the first one's knobs are the ones kept", () => {
    // Two entries can now name one model and disagree about how hard it thinks, which is what reordering a list
    // by hand produces. The one the user reads first is the one they meant.
    expect(
        resolveAgentRunModels([CLAUDE], [pin(`claude`, `claude-opus-5`, { effort: `max` }), pin(`claude`, `claude-opus-5`, { effort: `low` })]),
    ).toEqual([{ provider: `claude`, model: `claude-opus-5`, effort: `max` }]);
});

test("carries a model id the static catalog has never heard of", () => {
    // The picker offers a custom-id escape hatch, so a pin can name a model released after this build. Second-
    // guessing it here would quietly run something other than what the settings row says.
    expect(resolveAgentRunModels([CLAUDE], [pin(`claude`, `claude-opus-9-preview`)])).toEqual([
        { provider: `claude`, model: `claude-opus-9-preview` },
    ]);
});
