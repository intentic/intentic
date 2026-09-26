import { shapeFlow, shapeSevers, TOO_OLD_TO_SAVE } from "./shapeFlow";

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
test(`a set-shape carries the contract's four fields and nothing else`, () => {
    const reported = { ...bigger, swapGib: 4 };
    expect(shapeFlow({ shape: reported, when: `now` }, true, running)).toEqual({ op: `set-shape`, payload: { shape: bigger, when: `now` } });
});

test(`an older agent is sent the old op's delta for Apply, and refuses a save rather than restarting`, () => {
    expect(shapeFlow({ shape: bigger, when: `now` }, false, running)).toEqual({ op: `reshape`, payload: { resources: { memoryGib: 20 } } });
    expect(() => shapeFlow({ shape: bigger, when: `nextRestart` }, false, running)).toThrow(TOO_OLD_TO_SAVE);
    expect(() => shapeFlow({ forget: true }, false, running)).toThrow(TOO_OLD_TO_SAVE);
    // Nothing differs: the old op's empty ask meant "restart onto what is saved", which is never sent by accident.
    expect(() => shapeFlow({ shape: running, when: `now` }, false, running)).toThrow(/nothing to apply/);
});

test(`only a shape applied now takes the container, and the connection through it, down`, () => {
    expect(shapeSevers({ shape: bigger, when: `now` })).toBe(true);
    expect(shapeSevers({ shape: bigger, when: `nextRestart` })).toBe(false);
    expect(shapeSevers({ forget: true })).toBe(false);
});
