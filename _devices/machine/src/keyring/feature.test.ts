import { keyringProbe, type KeyringProbeDeps } from "./feature.js";

// Whether describe advertises `keyring`: only with the binary installed and the pipe answering, and asked at most once
// per half minute however often describe runs.

interface Fake extends KeyringProbeDeps {
    asked: number;
    clock: number;
    present: boolean;
    answering: boolean;
}

const fake = (): Fake => {
    const state: Fake = {
        asked: 0,
        clock: 0,
        present: true,
        answering: true,
        installed: () => state.present,
        answers: async () => {
            state.asked += 1;
            return await Promise.resolve(state.answering);
        },
        now: () => state.clock,
    };
    return state;
};

test("not installed is not advertised, and the pipe is not even asked", async () => {
    const deps = fake();
    deps.present = false;
    expect(await keyringProbe(deps, 30_000)()).toBe(false);
    expect(deps.asked).toBe(0);
});

test("installed and answering is advertised; installed and silent is not", async () => {
    const answering = fake();
    expect(await keyringProbe(answering, 30_000)()).toBe(true);
    const silent = fake();
    silent.answering = false;
    expect(await keyringProbe(silent, 30_000)()).toBe(false);
});

test("an answer is believed for the TTL, then asked again", async () => {
    const deps = fake();
    const probe = keyringProbe(deps, 30_000);
    expect(await probe()).toBe(true);
    deps.answering = false;
    deps.clock = 29_999;
    expect(await probe()).toBe(true);
    expect(deps.asked).toBe(1);
    deps.clock = 30_000;
    expect(await probe()).toBe(false);
    expect(deps.asked).toBe(2);
});

test("describes at once share one ask", async () => {
    const deps = fake();
    const probe = keyringProbe(deps, 30_000);
    expect(await Promise.all([probe(), probe(), probe()])).toEqual([true, true, true]);
    expect(deps.asked).toBe(1);
});
