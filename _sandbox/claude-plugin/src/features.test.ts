import { type OptionKey, OPTIONS, optionEnvName, readOptions } from "./features.js";

// What a hook believes the person chose, read back from the environment Claude Code gives it.

test("an option nobody set is its default", () => {
    const options = readOptions({});
    for (const key of Object.keys(OPTIONS) as OptionKey[]) {
        expect(options[key]).toBe(OPTIONS[key].default);
    }
});

test("booleans read the spellings a settings file can hold, and anything else is the default", () => {
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_OUTPUT_CLEANERS: "false" }).output_cleaners).toBe(false);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_FIELD_NOTES: "off" }).field_notes).toBe(false);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_FILEQ: "no" }).fileq).toBe(false);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_PROJECT_MAP: "0" }).project_map).toBe(false);
    // An unsubstituted placeholder is not a choice.
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_IQ: "${user_config.iq}" }).iq).toBe(OPTIONS.iq.default);
});

test("shares are clamped to their bounds, and an unreadable one is the default", () => {
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_HOLDOUT: "0.25" }).holdout).toBe(0.25);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_HOLDOUT: "0.9" }).holdout).toBe(OPTIONS.holdout.max);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_HOLDOUT: "-1" }).holdout).toBe(0);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_HOLDOUT: "lots" }).holdout).toBe(OPTIONS.holdout.default);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_OUTPUT_HOLDOUT: "" }).output_holdout).toBe(OPTIONS.output_holdout.default);
});

test("strings pass through as written", () => {
    expect(readOptions({ [optionEnvName("cleaners")]: "-cap,-wide" }).cleaners).toBe("-cap,-wide");
});
