import { HANDOVER_MS, type LaunchEffects, launchAgent, launches, standingLaunches } from "./agentLaunches";

// An agent started from a press elsewhere (Pipelines' Fix with agent) is on the board from the press, not from the
// sandbox's answer seconds later, and a refusal is said where the reader is.

const effects = (onBoard: boolean, calls: string[] = []): LaunchEffects & { readonly calls: string[] } => ({
    calls,
    here: () => ({ path: `/ext/pipelines`, label: `Pipelines` }),
    openBoard: () => {
        // What the board's first frame reads: the card is already there.
        calls.push(`open:${launches.value.map((launch) => launch.title).join(`,`)}`);
    },
    onBoard: () => onBoard,
    focus: (id) => calls.push(`focus:${id}`),
    refused: (title, message) => calls.push(`refused:${title}:${message}`),
});

const held = <T>() => {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

beforeEach(() => {
    launches.value = [];
});

test(`the card is on the board before it opens, says nothing came back yet, and hands over to the agent it answers with`, async () => {
    const answer = held<{ conversationId: string }>();
    const fx = effects(true);
    const launched = launchAgent({ title: `Fix CI: build broke`, note: `Reading the failed jobs' logs` }, () => answer.promise, fx);

    expect(fx.calls).toEqual([`open:Fix CI: build broke`]);
    expect(launches.value).toMatchObject([{ title: `Fix CI: build broke`, note: `Reading the failed jobs' logs`, from: { path: `/ext/pipelines` } }]);
    expect(launches.value[0]?.conversationId).toBeUndefined();

    answer.resolve({ conversationId: `ci-fix-web-41` });
    await expect(launched).resolves.toEqual({ conversationId: `ci-fix-web-41` });
    expect(launches.value[0]?.conversationId).toBe(`ci-fix-web-41`);
    expect(fx.calls).toEqual([`open:Fix CI: build broke`, `focus:ci-fix-web-41`]);
});

test(`the card gives way the moment the roster holds its agent, and is gone after the handover window whatever the roster says`, async () => {
    jest.useFakeTimers();
    try {
        await launchAgent({ title: `Fix CI` }, async () => ({ conversationId: `ci-fix-web-41` }), effects(true));
        expect(standingLaunches(launches.value, () => false)).toHaveLength(1);
        expect(standingLaunches(launches.value, (id) => id === `ci-fix-web-41`)).toHaveLength(0);
        jest.advanceTimersByTime(HANDOVER_MS);
        expect(launches.value).toEqual([]);
    } finally {
        jest.useRealTimers();
    }
});

test(`a refusal is said on the card while the reader is on the board, and thrown back to the press`, async () => {
    const fx = effects(true);
    await expect(launchAgent({ title: `Fix CI` }, () => Promise.reject(new Error(`Not a code failure: the runner's disk is full`)), fx)).rejects.toThrow(
        `the runner's disk is full`,
    );
    expect(launches.value).toMatchObject([{ title: `Fix CI`, failure: `Not a code failure: the runner's disk is full` }]);
    expect(fx.calls.some((call) => call.startsWith(`refused`))).toBe(false);
});

test(`a refusal after the reader left the board is a toast, and leaves no card behind to meet them later`, async () => {
    const fx = effects(false);
    await expect(launchAgent({ title: `Fix CI` }, () => Promise.reject(new Error(`An attempt is already in play`)), fx)).rejects.toThrow();
    expect(launches.value).toEqual([]);
    expect(fx.calls).toContain(`refused:Fix CI:An attempt is already in play`);
});

test(`an answer after the reader left the board does not pull them back`, async () => {
    const fx = effects(false);
    await launchAgent({ title: `Fix CI` }, async () => ({ conversationId: `ci-fix-web-41` }), fx);
    expect(fx.calls.some((call) => call.startsWith(`focus`))).toBe(false);
});
