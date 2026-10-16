import { carryPinKnobs, defaultPinRunSettings, honoredPinKnobs, pinKnobSummary } from "./pickerRunSettings";

test("defaultPinRunSettings offers effort and thinking only where the runtime honors them", () => {
    expect(defaultPinRunSettings(`claude`, `native`)).toEqual({ effort: `xhigh`, thinking: true });
    expect(defaultPinRunSettings(`codex`, `native`)).toEqual({ effort: `xhigh` });
    // OpenCode carries an effort tier as a model variant; only Claude takes a thinking switch.
    expect(defaultPinRunSettings(`gemini`, `native`)).toEqual({ effort: `xhigh` });
});

test("carryPinKnobs keeps effort across effort-capable providers, Google included, and drops what a loop cannot take", () => {
    expect(carryPinKnobs({ provider: `codex`, model: `gpt-5.6`, effort: `high` }, `claude`, `native`)).toEqual({ effort: `high` });
    expect(carryPinKnobs({ provider: `claude`, model: `claude-haiku-4-5`, effort: `high`, thinking: false }, `gemini`, `native`)).toEqual({ effort: `high` });
});

test("honoredPinKnobs and pinKnobSummary omit the knob Google cannot run, and keep the one it can", () => {
    const pin = { provider: `gemini` as const, model: `gemini-3-flash-lite`, effort: `xhigh`, thinking: true };
    expect(honoredPinKnobs(pin)).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite`, effort: `xhigh` });
    expect(pinKnobSummary(pin)).toBe(`X-High`);
});

test("pinKnobSummary names the model's default effort for a pin that stores none, where the model takes one", () => {
    expect(pinKnobSummary({ provider: `claude`, model: `claude-opus-5-5` })).toBe(`default effort`);
    expect(pinKnobSummary({ provider: `codex`, model: `gpt-5.6`, effort: `high` })).toBe(`High`);
    expect(pinKnobSummary({ provider: `gemini`, model: `gemini-3-flash-lite` })).toBe(`default effort`);
    // A loop that takes no effort at all says nothing about one.
    expect(pinKnobSummary({ provider: `devin`, model: `swe-1-6` })).toBeUndefined();
});

test("pinKnobSummary names a loop other than the provider's default, and never the default", () => {
    expect(pinKnobSummary({ provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` })).toBe(`High · Claude Code`);
    expect(pinKnobSummary({ provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `codex` })).toBe(`High`);
    expect(pinKnobSummary({ provider: `claude`, model: `claude-opus-5-5`, harness: `claude-code` })).toBe(`default effort`);
});
