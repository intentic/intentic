import { recordOptions, type SessionModels, sessionThoughtsOf, thoughtFor } from "./acp-model.js";

const levels = (...values: string[]): SessionModels => ({ configId: "thought", current: values[0] ?? "", choices: values.map((value) => ({ value, name: value })) });

test("an effort spelled as one of the agent's levels picks it", () => {
    expect(thoughtFor(levels("low", "medium", "high"), "medium")).toBe("medium");
});

test("an effort the agent has no level for takes the nearest below, else the nearest above", () => {
    expect(thoughtFor(levels("low", "medium", "high"), "max")).toBe("high");
    expect(thoughtFor(levels("medium", "high"), "minimal")).toBe("medium");
});

test("levels that name no tier, or an effort that is none, pick nothing", () => {
    expect(thoughtFor(levels("fast", "deep"), "high")).toBeUndefined();
    expect(thoughtFor(levels("low", "high"), "turbo")).toBeUndefined();
});

test("a level named by its label rather than its value still counts", () => {
    const named: SessionModels = { configId: "t", current: "a", choices: [{ value: "a", name: "Low" }, { value: "b", name: "High" }] };
    expect(thoughtFor(named, "high")).toBe("b");
});

test("one answer records both options, and an answer naming neither forgets them", () => {
    const state = { models: new Map<string, SessionModels>(), thoughts: new Map<string, SessionModels>() };
    recordOptions(state, "s", [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "swe", options: [{ value: "swe", name: "SWE" }] },
        { id: "effort", name: "Thinking", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }] },
    ]);
    expect([state.models.get("s")?.current, state.thoughts.get("s")?.configId]).toEqual(["swe", "effort"]);
    recordOptions(state, "s", []);
    expect([state.models.has("s"), state.thoughts.has("s")]).toEqual([false, false]);
    expect(sessionThoughtsOf(undefined)).toBeUndefined();
});
