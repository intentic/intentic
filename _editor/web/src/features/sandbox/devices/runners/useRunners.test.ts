// The runners list is a daemon read like any other: while the sandbox is out of reach it is not asked at all, rather than
// every fifteen seconds into a daemon that is down, and it is asked the moment the sandbox answers again.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { effectScope, type EffectScope } from "vue";

const sandboxJson = jest.fn(async (_path: string) => ({ runners: [] }));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxJson, sandboxError: jest.fn(), sandboxRequest: jest.fn() }));
// The streaming verbs beside the list are not what this suite is about.
jest.mock(`../useDevices`, () => ({ manageDeviceSandbox: jest.fn() }));

const { useRunners } = await import(`./useRunners`);
const { signalConnection } = await import(`../../../../client/sandbox/useSandbox`);
const { classifyFailure } = await import(`../../../../client/sandbox/connection`);
const { queryClient } = await import(`../../../../lib/queryPersistence`);

let scope: EffectScope | undefined;
afterEach(() => {
    scope?.stop();
    scope = undefined;
    queryClient.clear();
});

test("an unreachable sandbox is not asked for its runners, and is asked once it answers again", async () => {
    signalConnection({ kind: `failed`, failure: classifyFailure({ message: `tunnel down` }), at: Date.now() });
    scope = effectScope();
    scope.run(() => useRunners());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sandboxJson).toHaveBeenCalledTimes(0);

    signalConnection({ kind: `frame`, at: Date.now() });

    await waitFor(() => expect(sandboxJson).toHaveBeenCalledWith(`/system/runners`));
});
