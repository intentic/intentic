import { composeWirePrompt, LITERAL_SLASH_NOTE } from "../prompt/turn-preamble.js";
import { LANDING_CHECKS_NOTE } from "../prompt/checks-note.js";
import { commandNotesHooks, commandWire } from "./command-turn.js";

const wire = composeWirePrompt([LANDING_CHECKS_NOTE], "/code-review high --fix");

// The CLI parses a command only at the very start of the message: the notes in front made every command prose.
test("a command turn sends its words alone and keeps the notes it cut from in front of them", () => {
    expect(commandWire({ prompt: wire, command: "code-review" })).toEqual({ prompt: "/code-review high --fix", notes: LANDING_CHECKS_NOTE.text });
});

test("every other turn sends the composed prompt untouched", () => {
    expect(commandWire({ prompt: wire })).toEqual({ prompt: wire });
    const prose = composeWirePrompt([LANDING_CHECKS_NOTE, LITERAL_SLASH_NOTE], "/workspace view forgets the tree");
    expect(commandWire({ prompt: prose })).toEqual({ prompt: prose });
    // Nothing in front: already as the CLI must see it, and no hook is owed.
    expect(commandWire({ prompt: "/compact", command: "compact" })).toEqual({ prompt: "/compact" });
});

const fire = (hooks: ReturnType<typeof commandNotesHooks>) => ("UserPromptSubmit" in hooks ? hooks.UserPromptSubmit[0]?.hooks[0]?.() : undefined);

// The hook fires for every prompt the session takes; a steered message later in the turn is not the command's.
test("the notes are said once, with the turn's first prompt", async () => {
    const hooks = commandNotesHooks("## Checks after landing\n\nrun the tests");
    expect(await fire(hooks)).toEqual({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "## Checks after landing\n\nrun the tests" },
    });
    expect(await fire(hooks)).toEqual({});
});

test("a turn with nothing cut wires no hook", () => {
    expect(commandNotesHooks(undefined)).toEqual({});
});
