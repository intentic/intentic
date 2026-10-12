import type { ModelPin } from "../schemas/agent.js";
import type { ModelSource } from "./model-pins.js";
import { endpointProvider } from "./agent-catalog.js";
import type { ModelRole } from "./model-roles.js";
import { ladderIsEmpty, presetPins, roleLadder, rolePins, roleSetupId, setupsFromRoleLists } from "./model-setups.js";

// What a job runs on is read here by the daemon and the browser alike, so the rules are pinned once: where a job starts,
// what a preset is worked out from, and what a written setup overrides.

const opus: ModelPin = { provider: `claude`, model: `claude-opus-5-5`, effort: `high` };
const haiku: ModelPin = { provider: `claude`, model: `claude-haiku-4-5` };

const CLAUDE: ModelSource = { provider: `claude`, ready: true, models: [`claude-haiku-4-5-20251001`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`] };
const CODEX: ModelSource = { provider: `codex`, ready: true, models: [`gpt-5.2-codex`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5-mini`] };
const GEMINI: ModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3-pro`] };

const NOTHING_SET = { modelSetups: [], roleSetups: {} };

describe(`a preset worked out from what is connected`, () => {
    test(`takes each connected provider's newest model on the preset's rung, in the order they come`, () => {
        expect(presetPins(`high`, [CLAUDE, CODEX, GEMINI]).map((pin) => pin.model)).toEqual([`claude-opus-5`, `gpt-5.6-sol`, `gemini-3-pro`]);
        expect(presetPins(`medium`, [CLAUDE, CODEX, GEMINI]).map((pin) => pin.model)).toEqual([`claude-sonnet-5`, `gpt-5.6-terra`, `gemini-3-flash`]);
        expect(presetPins(`low`, [CLAUDE, CODEX, GEMINI]).map((pin) => pin.model)).toEqual([`claude-haiku-4-5-20251001`, `gpt-5.6-luna`, `gemini-3-flash-lite`]);
    });

    test(`leaves out a provider that is not connected, a local endpoint, and anything past three`, () => {
        const local: ModelSource = { provider: endpointProvider(`ollama`), ready: true, models: [`qwen-coder`] };
        const extra: ModelSource = { provider: `grok`, ready: true, models: [`grok-5-heavy`] };
        expect(presetPins(`high`, [{ ...CLAUDE, ready: false }, local, CODEX, GEMINI, extra]).map((pin) => pin.provider)).toEqual([`codex`, `gemini`, `grok`]);
        expect(presetPins(`high`, [CLAUDE, CODEX, GEMINI, extra])).toHaveLength(3);
    });

    test(`takes a provider's own model over one it serves from another maker`, () => {
        const google: ModelSource = { provider: `gemini`, ready: true, models: [`claude-opus-4-6-thinking`, `gemini-3-pro`, `gemini-3-flash`] };
        expect(presetPins(`high`, [google])).toEqual([{ provider: `gemini`, model: `gemini-3-pro` }]);
        // With none of its own on the rung, the borrowed one still serves.
        expect(presetPins(`high`, [{ ...google, models: [`claude-opus-4-6-thinking`, `gemini-3-flash`, `gemini-3-flash-lite`] }])).toEqual([
            { provider: `gemini`, model: `claude-opus-4-6-thinking` },
        ]);
    });

    test(`is empty while nothing is connected`, () => {
        expect(presetPins(`low`, [])).toEqual([]);
    });
});

describe(`which setup a job runs on`, () => {
    test(`a job nobody placed runs on nothing, however much is connected`, () => {
        expect(roleSetupId(NOTHING_SET, `commit-message`)).toBeUndefined();
        expect(ladderIsEmpty(roleLadder(NOTHING_SET, `safety-judge`))).toBe(true);
        expect(rolePins(NOTHING_SET, `pipeline-fix`, [CLAUDE, CODEX, GEMINI])).toEqual([]);
    });

    test(`a job put on a preset nobody edited runs what is connected, and follows it`, () => {
        const settings = { modelSetups: [], roleSetups: { "commit-message": `low` } };
        expect(roleLadder(settings, `commit-message`)).toEqual({ kind: `preset`, preset: `low` });
        expect(rolePins(settings, `commit-message`, [CLAUDE])).toEqual([{ provider: `claude`, model: `claude-haiku-4-5-20251001` }]);
    });

    test(`a written preset is run as written, and stops following what is connected`, () => {
        const settings = { modelSetups: [{ id: `low`, pins: [opus] }], roleSetups: { "commit-message": `low` } };
        expect(rolePins(settings, `commit-message`, [CLAUDE, CODEX])).toEqual([opus]);
    });

    test(`a preset that was only renamed still follows what is connected`, () => {
        const settings = { modelSetups: [{ id: `low`, name: `Cheap` }], roleSetups: { "commit-message": `low` } };
        expect(roleLadder(settings, `commit-message`)).toEqual({ kind: `preset`, preset: `low` });
    });

    test(`a job put on a setup of the owner's runs that setup's models`, () => {
        const settings = { modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [opus, haiku] }], roleSetups: { "commit-message": `setup-1` } };
        expect(rolePins(settings, `commit-message`, [CLAUDE])).toEqual([opus, haiku]);
    });

    test(`a job put on a setup that is gone is on none`, () => {
        const settings = { modelSetups: [], roleSetups: { "commit-message": `setup-9` } };
        expect(roleSetupId(settings, `commit-message`)).toBeUndefined();
    });

    test(`a setup of the owner's with no models is empty, never a preset`, () => {
        const settings = { modelSetups: [{ id: `setup-1`, name: `Later` }], roleSetups: { "pipeline-fix": `setup-1` } };
        expect(ladderIsEmpty(roleLadder(settings, `pipeline-fix`))).toBe(true);
    });
});

test(`per-job lists become setups every job runs exactly as before on`, () => {
    const cases = [
        [`commit-message`, [haiku]],
        [`session-title`, [haiku]],
        [`pipeline-fix`, [opus]],
        [`safety-judge`, []],
    ] as const satisfies readonly (readonly [ModelRole, readonly ModelPin[]])[];
    const settings = setupsFromRoleLists(Object.fromEntries(cases));

    for (const [role, pins] of cases) {
        expect(rolePins(settings, role, [CLAUDE, CODEX])).toEqual(pins);
    }
    // A job that never had a list, or had an empty one, ran on nothing and is on none.
    expect([settings.roleSetups[`loop-iteration`], settings.roleSetups[`safety-judge`]]).toEqual([undefined, undefined]);
});
