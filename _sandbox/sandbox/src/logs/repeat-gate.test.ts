import { createRepeatGate } from "./repeat-gate.js";

test("the first line of a state passes, identical repeats are held and counted onto the next line", () => {
    let at = 0;
    const gate = createRepeatGate({ everyMs: 1000, now: () => at });
    expect(gate.check("ci:intentic", "401")).toEqual({ log: true, repeated: 0 });
    expect(gate.check("ci:intentic", "401")).toEqual({ log: false, repeated: 1 });
    expect(gate.check("ci:intentic", "401")).toEqual({ log: false, repeated: 2 });
    at = 1000;
    expect(gate.check("ci:intentic", "401")).toEqual({ log: true, repeated: 2 });
});

test("a changed state passes at once, and keys do not share a state", () => {
    const gate = createRepeatGate({ everyMs: 60_000, now: () => 0 });
    gate.check("ci:a", "401");
    expect(gate.check("ci:b", "401").log).toBe(true);
    expect(gate.check("ci:a", "500")).toEqual({ log: true, repeated: 0 });
});

test("clear answers the outage it ends, once", () => {
    const gate = createRepeatGate({ now: () => 0 });
    expect(gate.clear("device:rog")).toBeUndefined();
    gate.check("device:rog", "refused");
    gate.check("device:rog", "refused");
    expect(gate.clear("device:rog")).toEqual({ state: "refused", repeated: 1 });
    expect(gate.clear("device:rog")).toBeUndefined();
    expect(gate.check("device:rog", "refused").log).toBe(true);
});
