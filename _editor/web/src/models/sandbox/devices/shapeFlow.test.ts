import { shapeFlow, shapeSevers, tooOldToSave, tooOldWords } from "./shapeFlow";

// What the resources form's answer becomes on the wire. An agent with `set-shape` is sent the whole shape and nothing is
// merged on this side; an older one is sent only the old op's delta, now, and can save nothing.

const running = { memoryGib: 12, cpus: null, privileged: false, gpu: false };
const bigger = { ...running, memoryGib: 20 };

test(`an agent that takes whole shapes is sent the whole shape, or the forget`, () => {
    expect(shapeFlow({ shape: bigger, when: `nextRestart` }, true, running)).toEqual({ op: `set-shape`, payload: { shape: bigger, when: `nextRestart` } });
    expect(shapeFlow({ shape: bigger, when: `now` }, true, running)).toEqual({ op: `set-shape`, payload: { shape: bigger, when: `now` } });
    expect(shapeFlow({ forget: true }, true, running)).toEqual({ op: `forget-shape`, payload: {} });
});

// The agent's input is strict all the way down, so a field a newer machine's report added to the running shape must not
// ride along into the order.
test(`a set-shape carries the contract's fields and nothing else`, () => {
    const reported = { ...bigger, diskGib: 40 };
    expect(shapeFlow({ shape: reported, when: `now` }, true, running)).toEqual({ op: `set-shape`, payload: { shape: bigger, when: `now` } });
});

// The swap (2026-11-05) is the contract's, and rides exactly when the machine's report carried it: a form opened on an
// older machine has no swap, and sending one would be refused by an agent that does not know it.
test(`a set-shape carries the swap the machine reported, its default included, and none it did not`, () => {
    expect(shapeFlow({ shape: { ...bigger, swapGib: 4 }, when: `now` }, true, running)).toEqual({
        op: `set-shape`,
        payload: { shape: { ...bigger, swapGib: 4 }, when: `now` },
    });
    expect(shapeFlow({ shape: { ...bigger, swapGib: null }, when: `nextRestart` }, true, running).payload.shape).toEqual({ ...bigger, swapGib: null });
    expect(shapeFlow({ shape: bigger, when: `now` }, true, running).payload.shape).not.toHaveProperty(`swapGib`);
    // The old op's delta never learned the swap: an agent that old is sent the caps alone.
    expect(shapeFlow({ shape: { ...bigger, swapGib: 4 }, when: `now` }, false, running)).toEqual({ op: `reshape`, payload: { resources: { memoryGib: 20 } } });
});

test(`an older agent is sent the old op's delta for Apply, and refuses a save rather than restarting`, () => {
    expect(shapeFlow({ shape: bigger, when: `now` }, false, running)).toEqual({ op: `reshape`, payload: { resources: { memoryGib: 20 } } });
    expect(() => shapeFlow({ shape: bigger, when: `nextRestart` }, false, running)).toThrow(tooOldWords());
    expect(() => shapeFlow({ forget: true }, false, running)).toThrow(tooOldWords());
    // Nothing differs: the old op's empty ask meant "restart onto what is saved", which is never sent by accident.
    expect(() => shapeFlow({ shape: running, when: `now` }, false, running)).toThrow(/nothing to apply/);
});

test(`only a shape applied now takes the container, and the connection through it, down`, () => {
    expect(shapeSevers({ shape: bigger, when: `now` })).toBe(true);
    expect(shapeSevers({ shape: bigger, when: `nextRestart` })).toBe(false);
    expect(shapeSevers({ forget: true })).toBe(false);
});

// A machine can lack the save for two reasons, and the refusal says the true one: an agent older than the feature is
// updated to fix it, but an agent as new as the feature over an `ic` it failed to fetch says so itself, and that
// sentence is the one to show.
test(`refuses a save in the agent's own words about its stale ic when it gave them`, () => {
    const stale = `ic is out of date: the installed ic is 1.310.0, this agent is 1.316.0, and fetching ic 1.316.0 failed (offline).`;
    expect(tooOldToSave({ icOutOfDate: stale })).toBe(stale);
    expect(tooOldToSave({})).toBe(tooOldWords());
    expect(tooOldToSave(undefined)).toBe(tooOldWords());
    expect(() => shapeFlow({ shape: bigger, when: `nextRestart` }, false, running, stale)).toThrow(stale);
});
