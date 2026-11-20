// A device socket's token, kept fresh: renewed halfway through its life as this computer saw it arrive, bounded both
// ways, handed to the open socket, retried after a failed renewal, and asked for at once when a dial needs a fresh one.
import type { RemoteToken } from "./remoteApi";
import { MAX_RENEW_MS, MIN_RENEW_MS, renewAfter, RETRY_MS, tokenKeeper } from "./remoteToken";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const harness = (answers: (RemoteToken | Error)[]) => {
    let clock = 1_000_000;
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const renewed: string[] = [];
    let asked = 0;
    const keeper = tokenKeeper({
        refresh: async () => {
            const answer = answers[asked] ?? new Error(`no more answers`);
            asked += 1;
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        },
        renewed: (token) => renewed.push(token.token),
        now: () => clock,
        later: (run, ms) => {
            const timer = { run, ms, cancelled: false };
            timers.push(timer);
            return () => (timer.cancelled = true);
        },
    });
    const pending = () => timers.filter((timer) => !timer.cancelled);
    const fire = async (): Promise<void> => {
        const next = pending().at(-1)!;
        next.cancelled = true;
        next.run();
        await settle();
    };
    return { keeper, renewed, pending, fire, at: () => clock, tick: (ms: number) => (clock += ms), asked: () => asked };
};

it("renews halfway through a token's life, never sooner than MIN_RENEW_MS nor later than MAX_RENEW_MS", () => {
    expect(renewAfter(120_000)).toBe(60_000);
    expect(renewAfter(2_000)).toBe(MIN_RENEW_MS);
    expect(renewAfter(3_600_000)).toBe(MAX_RENEW_MS);
    // A clock far ahead of the sandbox's reads every token as lapsed: renewed as if it had a minute, not hammered.
    expect(renewAfter(-30_000)).toBe(30_000);
});

it("holds the grant's token, renews it on time and hands the fresh one to the open socket", async () => {
    const { keeper, renewed, pending, fire, at } = harness([{ token: `t2`, expiresAt: 1_000_000 + 300_000 }]);
    keeper.take({ token: `t1`, expiresAt: at() + 120_000 });
    expect(keeper.current()).toBe(`t1`);
    expect(pending().map((timer) => timer.ms)).toEqual([60_000]);
    await fire();
    expect(keeper.current()).toBe(`t2`);
    expect(renewed).toEqual([`t2`]);
    expect(pending().map((timer) => timer.ms)).toEqual([150_000]);
});

it("keeps the token it has when a renewal fails, and tries again after RETRY_MS", async () => {
    const { keeper, renewed, pending, fire, at } = harness([new Error(`offline`), { token: `t2`, expiresAt: 1_000_000 + 60_000 }]);
    keeper.take({ token: `t1`, expiresAt: at() + 60_000 });
    await fire();
    expect(keeper.current()).toBe(`t1`);
    expect(renewed).toEqual([]);
    expect(pending().map((timer) => timer.ms)).toEqual([RETRY_MS]);
    await fire();
    expect(keeper.current()).toBe(`t2`);
    expect(renewed).toEqual([`t2`]);
});

it("asks for a fresh token at once for a dial, without handing it to a socket that is not open", async () => {
    const { keeper, renewed, asked } = harness([{ token: `t9`, expiresAt: 1_000_000 + 60_000 }]);
    await expect(keeper.fresh()).resolves.toBe(`t9`);
    expect(keeper.current()).toBe(`t9`);
    expect(asked()).toBe(1);
    expect(renewed).toEqual([]);
});

it("stops renewing once disposed", async () => {
    const { keeper, pending, at, asked } = harness([{ token: `t2`, expiresAt: 0 }]);
    keeper.take({ token: `t1`, expiresAt: at() + 60_000 });
    keeper.dispose();
    expect(pending()).toEqual([]);
    expect(asked()).toBe(0);
});
