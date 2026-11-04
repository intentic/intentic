// A surface showing files from a conversation's own copy keeps the daemon watching them: asked at once, renewed at half
// the lease, and let go (no more asks) when the surface moves to the shared tree, loses the sandbox, or goes. A failed
// ask is tried again later rather than ending the follow.
import { effectScope, nextTick, ref } from "vue";
import type { ViewScope } from "../../../app/workspaceScope";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

const asked: { agent: string; paths: string[] }[] = [];
let failNext = false;
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({
        workspace: {
            followCheckout: async (input: { agent: string; paths: string[] }) => {
                asked.push(input);
                if (failNext) {
                    failNext = false;
                    throw new Error(`refused`);
                }
                return { leaseMs: 20_000 };
            },
        },
    }),
}));
const reachable = ref(true);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable }) }));

const { useFollowCheckout } = await import("./useFollowCheckout");

// Lets the ask's promise settle and the next one be scheduled.
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
};

const follow = (paths: () => readonly string[], scope: () => ViewScope) => {
    const scopeOf = effectScope();
    scopeOf.run(() => useFollowCheckout(paths, scope));
    return scopeOf;
};

beforeEach(() => {
    jest.useFakeTimers();
    asked.length = 0;
    failNext = false;
    reachable.value = true;
});

afterEach(() => {
    jest.useRealTimers();
});

test("asks at once and renews at half the lease while the copy is on screen", async () => {
    const running = follow(
        () => [`docs/a.md`, `docs/a.md`],
        () => ({ agent: `c-1` }),
    );
    await settle();
    expect(asked).toEqual([{ agent: `c-1`, paths: [`docs/a.md`] }]);
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(asked).toHaveLength(2);
    running.stop();
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(asked).toHaveLength(2);
});

test("asks nothing for the shared tree, or with nothing to follow", async () => {
    follow(
        () => [`docs/a.md`],
        () => ({}),
    ).stop();
    follow(
        () => [],
        () => ({ agent: `c-1` }),
    ).stop();
    await settle();
    expect(asked).toEqual([]);
});

test("stops renewing when the sandbox stops answering, and asks again when it does", async () => {
    const running = follow(
        () => [`docs/a.md`],
        () => ({ agent: `c-1` }),
    );
    await settle();
    reachable.value = false;
    await settle();
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(asked).toHaveLength(1);
    reachable.value = true;
    await settle();
    expect(asked).toHaveLength(2);
    running.stop();
});

test("a refused ask is tried again later", async () => {
    failNext = true;
    const running = follow(
        () => [`docs/a.md`],
        () => ({ agent: `c-1` }),
    );
    await settle();
    expect(asked).toHaveLength(1);
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(asked).toHaveLength(2);
    running.stop();
});
