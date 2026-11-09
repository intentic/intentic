// A pick from the shell's model list (the account gate's "Choose another model", a model refusal's notice) applied to the
// pane's conversation, as the composer's own list applies one.
import type { PickAction } from "../session/selectionReducer";

import { applyChoice } from "./paneModelPick";

const loaded: string[] = [];

const applied = (choice: Parameters<typeof applyChoice>[1]): PickAction[] => {
    const actions: PickAction[] = [];
    applyChoice({ selection: { apply: (action: PickAction) => void actions.push(action) } }, choice, async (provider) => {
        loaded.push(provider);
    });
    return actions;
};

// A chat on an API key whose credit ran out, moved to a Claude sign-in from the list: the account rides the model pick,
// so the next turn names it on Claude. Applied as a move of its own, it asked the daemon to pin the sign-in's account on
// the conversation it still held on the key (2026-11-07).
it(`names the account with the model, never as a move of its own`, () => {
    const actions = applied({ provider: `claude`, model: `claude-opus-5-5`, label: `Claude Opus 5.5`, account: `acct-1` });

    expect(actions).toEqual([{ kind: `selectModel`, pick: { provider: `claude`, value: `claude-opus-5-5` }, account: `acct-1` }]);
    expect(loaded).toContain(`claude`);
});

it(`a pick with no account and a loop of its own picks the model, then the loop`, () => {
    const actions = applied({ provider: `codex`, model: `gpt-6.1`, label: `GPT-6.1`, harness: `codex` });

    expect(actions).toEqual([
        { kind: `selectModel`, pick: { provider: `codex`, value: `gpt-6.1` } },
        { kind: `selectHarness`, harness: `codex` },
    ]);
});
