import { test, expect } from "bun:test";
import { carryPinKnobs, defaultPinRunSettings, honoredPinKnobs, pinKnobSummary } from "./pickerRunSettings";

test("defaultPinRunSettings offers effort and thinking only where the runtime honors them", () => {
    expect(defaultPinRunSettings(`claude`, `native`)).toEqual({ effort: `xhigh`, thinking: true });
    expect(defaultPinRunSettings(`codex`, `native`)).toEqual({ effort: `xhigh` });
    expect(defaultPinRunSettings(`gemini`, `native`)).toEqual({});
});

test("carryPinKnobs keeps effort across effort-capable providers and drops it for Google", () => {
    expect(carryPinKnobs({ provider: `codex`, model: `gpt-5.6`, effort: `high` }, `claude`, `native`)).toEqual({ effort: `high` });
    expect(carryPinKnobs({ provider: `claude`, model: `claude-haiku-4-5`, effort: `high`, thinking: false }, `gemini`, `native`)).toEqual({});
});

test("honoredPinKnobs and pinKnobSummary omit knobs Google cannot run", () => {
    const pin = { provider: `gemini` as const, model: `gemini-3-flash-lite`, effort: `xhigh`, thinking: true };
    expect(honoredPinKnobs(pin)).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite` });
    expect(pinKnobSummary(pin)).toBeUndefined();
});
