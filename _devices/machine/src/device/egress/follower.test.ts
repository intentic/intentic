import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type FollowerChild, nextBackoff, startEgressFollower } from "./follower.js";

/* The follower's supervision: started only while ic advertises `egress`, restarted after every exit on a backoff that
   doubles to a minute and starts over after a run that held, and ended with the agent. */

afterEach(() => jest.useRealTimers());

interface Spawned extends FollowerChild {
    readonly end: (how: string) => void;
    stopped: boolean;
}

const harness = (advertised: () => boolean) => {
    const spawned: Spawned[] = [];
    const lines: string[] = [];
    let clock = 0;
    const follower = startEgressFollower((line) => lines.push(line), {
        advertised: async () => await Promise.resolve(advertised()),
        spawn: () => {
            let end: (how: string) => void = () => undefined;
            const child: Spawned = {
                exited: new Promise<string>((resolve) => {
                    end = resolve;
                }),
                end: (how) => end(how),
                stopped: false,
                stop: () => {
                    child.stopped = true;
                    end("it was ended by SIGTERM");
                },
            };
            spawned.push(child);
            return child;
        },
        now: () => clock,
    });
    return {
        spawned,
        lines,
        follower,
        tick: async (ms: number) => {
            clock += ms;
            await advanceTimersByTimeAsync(ms);
        },
    };
};

test("the backoff doubles to a minute and starts over after a run that held a minute", () => {
    expect(nextBackoff(1_000, 0, 10)).toEqual({ wait: 1_000, next: 2_000 });
    expect(nextBackoff(32_000, 0, 10)).toEqual({ wait: 32_000, next: 60_000 });
    expect(nextBackoff(60_000, 0, 10)).toEqual({ wait: 60_000, next: 60_000 });
    expect(nextBackoff(60_000, 0, 60_000)).toEqual({ wait: 1_000, next: 2_000 });
});

test("runs nothing while ic does not advertise egress, and starts once it does", async () => {
    jest.useFakeTimers();
    let advertised = false;
    const world = harness(() => advertised);
    await world.tick(0);
    expect(world.spawned).toHaveLength(0);
    advertised = true;
    await world.tick(10 * 60_000);
    expect(world.spawned).toHaveLength(1);
    world.follower.stop();
});

test("a follower that exits is started again after the backoff, and stop ends the one running", async () => {
    jest.useFakeTimers();
    const world = harness(() => true);
    await world.tick(0);
    expect(world.spawned).toHaveLength(1);
    world.spawned[0]?.end("it exited with code 1");
    await world.tick(0);
    expect(world.lines.at(-1)).toContain("it exited with code 1; starting it again in 1s");
    await world.tick(999);
    expect(world.spawned).toHaveLength(1);
    await world.tick(1);
    expect(world.spawned).toHaveLength(2);
    world.spawned[1]?.end("it exited with code 1");
    await world.tick(0);
    expect(world.lines.at(-1)).toContain("again in 2s");
    await world.tick(2_000);
    expect(world.spawned).toHaveLength(3);
    world.follower.stop();
    expect(world.spawned[2]?.stopped).toBe(true);
    await world.tick(120_000);
    expect(world.spawned).toHaveLength(3);
});
