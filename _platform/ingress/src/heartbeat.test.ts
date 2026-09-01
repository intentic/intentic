import { describe, expect, test, vi } from "vitest";
import { createHeartbeat, DEAD_AFTER_MS } from "./heartbeat.js";

// The clock is injected, so these read as "what happens after N seconds of silence" rather than as timer
// plumbing — which is the only question the heartbeat answers.
const world = (deadAfterMs = DEAD_AFTER_MS) => {
    let clock = 0;
    const ping = vi.fn();
    const onDead = vi.fn();
    const heartbeat = createHeartbeat({ ping, onDead, deadAfterMs, now: () => clock });
    return { heartbeat, ping, onDead, advance: (ms: number) => (clock += ms) };
};

describe(`createHeartbeat`, () => {
    test(`pings a peer that is still answering`, () => {
        const { heartbeat, ping, onDead } = world();
        heartbeat.tick();
        heartbeat.tick();

        expect(ping).toHaveBeenCalledTimes(2);
        expect(onDead).toHaveBeenCalledTimes(0);
    });

    // Three missed intervals, not one: a single dropped pong is ordinary on a congested link, and tearing down
    // a working tunnel for it is the more expensive mistake.
    test(`survives a lost pong inside the dead window`, () => {
        const { heartbeat, onDead, advance } = world();
        advance(DEAD_AFTER_MS - 1);
        heartbeat.tick();

        expect(onDead).toHaveBeenCalledTimes(0);
        expect(heartbeat.alive()).toBe(true);
    });

    test(`declares a peer dead once it has been silent past the window`, () => {
        const { heartbeat, ping, onDead, advance } = world();
        advance(DEAD_AFTER_MS + 1);
        heartbeat.tick();

        expect(onDead).toHaveBeenCalledTimes(1);
        // Not pinged on the way out: a peer that has gone quiet is not sent one more frame it will never answer.
        expect(ping).toHaveBeenCalledTimes(0);
        expect(heartbeat.alive()).toBe(false);
    });

    // Any frame counts as life, not just a pong: a tunnel carrying traffic is alive by definition.
    test(`a frame from the peer restarts the window`, () => {
        const { heartbeat, onDead, advance } = world();
        advance(DEAD_AFTER_MS - 1);
        heartbeat.saw();
        advance(DEAD_AFTER_MS - 1);
        heartbeat.tick();

        expect(onDead).toHaveBeenCalledTimes(0);
    });

    // The socket is torn down once; a tick that raced the teardown must not report it dead a second time.
    test(`reports death once, and never after stopping`, () => {
        const { heartbeat, onDead, advance } = world();
        advance(DEAD_AFTER_MS + 1);
        heartbeat.tick();
        heartbeat.tick();

        expect(onDead).toHaveBeenCalledTimes(1);
    });

    test(`a stopped heartbeat neither pings nor fires`, () => {
        const { heartbeat, ping, onDead, advance } = world();
        heartbeat.stop();
        advance(DEAD_AFTER_MS + 1);
        heartbeat.tick();

        expect(ping).toHaveBeenCalledTimes(0);
        expect(onDead).toHaveBeenCalledTimes(0);
    });
});
