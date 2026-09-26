import type { ChildAgentAsk } from "@intentic/sandbox-contract";
import { DEFAULT_EFFORT, DEFAULT_THINKING } from "../../models/run-settings/pickerRunSettings";
import { childRunFacts, childRunLine, pickedChildRun } from "./childAgentRun";

// The picker opens every knob at a state, never at "unset", so what it hands back for a child whose agent named no
// effort already carries the picker's default. Only what the owner actually moved may count as a change, or merely
// opening the picker and pressing its bar would re-point the child and announce a change nobody made.

const asked: ChildAgentAsk = { move: `spawn`, provider: `claude`, model: `claude-opus-4-6` };

describe(`pickedChildRun`, () => {
    it(`reads the picker's opening state, pressed as it stood, as no change`, () => {
        expect(pickedChildRun({ provider: `claude`, model: `claude-opus-4-6`, label: `Claude Opus 4.6`, effort: DEFAULT_EFFORT, thinking: DEFAULT_THINKING }, asked)).toBeUndefined();
    });

    it(`keeps a knob the agent left to the model out of a pick that changed something else`, () => {
        expect(pickedChildRun({ provider: `claude`, model: `claude-sonnet-4-6`, label: `Claude Sonnet 4.6`, effort: DEFAULT_EFFORT, thinking: DEFAULT_THINKING }, asked)).toEqual({
            provider: `claude`,
            model: `claude-sonnet-4-6`,
        });
    });

    it(`keeps a knob the owner moved off the picker's default`, () => {
        expect(pickedChildRun({ provider: `claude`, model: `claude-opus-4-6`, label: `Claude Opus 4.6`, effort: `low`, thinking: false }, asked)).toEqual({
            provider: `claude`,
            model: `claude-opus-4-6`,
            effort: `low`,
            thinking: false,
        });
    });

    it(`keeps the default where the agent had named something else`, () => {
        expect(pickedChildRun({ provider: `claude`, model: `claude-opus-4-6`, label: `Claude Opus 4.6`, effort: DEFAULT_EFFORT }, { ...asked, effort: `low` })).toEqual({
            provider: `claude`,
            model: `claude-opus-4-6`,
            effort: DEFAULT_EFFORT,
        });
    });

    it(`carries an account the owner chose`, () => {
        expect(pickedChildRun({ provider: `claude`, model: `claude-opus-4-6`, label: `Claude Opus 4.6`, account: `second` }, asked)).toEqual({
            provider: `claude`,
            model: `claude-opus-4-6`,
            account: `second`,
        });
    });
});

describe(`the run as the card reads it`, () => {
    it(`names the model the way the app does, with its speed`, () => {
        expect(childRunLine({ provider: `claude`, model: `claude-opus-4-6`, fast: true })).toBe(`Claude Opus 4.6 · Fast`);
    });

    it(`says which machine, and names an account nobody here has connected by its id`, () => {
        expect(childRunFacts({ ...asked, account: `work`, on: `here` }, { ...asked, account: `work` })).toEqual([`Account: work`, `In this sandbox`]);
    });

    it(`names the loop only where the provider has two that differ`, () => {
        expect(childRunFacts(asked, { ...asked, harness: `claude-code` })).toEqual([]);
        expect(childRunFacts(asked, { provider: `codex`, model: `gpt-5.5`, harness: `claude-code` })).toEqual([`Through Claude Code`]);
    });
});
