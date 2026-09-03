import { describe, expect, test, vi } from "vitest";
import { createFlyPeers, createStaticPeers, parsePeerList, peerKey } from "./peers.js";

const defaults = { port: 8080, internalPort: 8081 };

describe(`parsePeerList`, () => {
    test(`fills in this instance's own ports when an entry names only a host`, () => {
        expect(parsePeerList(`10.0.0.2, edge-b`, defaults)).toEqual([
            { host: `10.0.0.2`, port: 8080, internalPort: 8081 },
            { host: `edge-b`, port: 8080, internalPort: 8081 },
        ]);
    });

    test(`reads explicit ports, and a bracketed IPv6 literal`, () => {
        expect(parsePeerList(`127.0.0.1:9000:9001,[fdaa::2]:8080`, defaults)).toEqual([
            { host: `127.0.0.1`, port: 9000, internalPort: 9001 },
            { host: `fdaa::2`, port: 8080, internalPort: 8081 },
        ]);
    });

    test(`an empty list is no peers, not an error`, () => {
        expect(parsePeerList(``, defaults)).toEqual([]);
        expect(parsePeerList(` , `, defaults)).toEqual([]);
    });

    // A typo here is a cluster that forwards to nobody, which is a boot failure and must read as one.
    test(`refuses an entry it cannot read`, () => {
        expect(() => parsePeerList(`fdaa::2:8080`, defaults)).toThrow(/host\[:port/u);
    });
});

describe(`createStaticPeers`, () => {
    test(`holds the list in a stable order and never changes`, () => {
        const listener = vi.fn();
        const peers = createStaticPeers([
            { host: `b`, port: 1, internalPort: 2 },
            { host: `a`, port: 1, internalPort: 2 },
        ]);
        peers.onChange(listener);

        expect(peers.current().map((peer) => peer.host)).toEqual([`a`, `b`]);
        expect(listener).not.toHaveBeenCalled();
    });
});

describe(`createFlyPeers`, () => {
    // The resolver is injected, so these read as "what DNS answered" rather than as timer plumbing.
    const world = (answers: readonly (readonly string[] | Error)[]) => {
        let call = 0;
        const resolve = vi.fn(() => {
            // The last answer repeats forever, so a test may refresh more often than it scripted.
            const answer = answers[Math.min(call++, answers.length - 1)] ?? [];
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        });
        const log = vi.fn();
        const peers = createFlyPeers({ appName: `edge`, selfAddress: `fdaa::1`, port: 8080, internalPort: 8081, resolve, log });
        const changes: (readonly string[])[] = [];
        peers.onChange((next) => changes.push(next.map((peer) => peer.host)));
        return { peers, resolve, log, changes };
    };

    test(`asks the app's internal name and leaves itself out of the answer`, async () => {
        const { peers, resolve, changes } = world([[`fdaa::3`, `fdaa::1`, `fdaa::2`]]);
        await peers.refresh();

        expect(resolve).toHaveBeenCalledWith(`edge.internal`);
        expect(peers.current().map(peerKey)).toEqual([`fdaa::2|8080|8081`, `fdaa::3|8080|8081`]);
        expect(changes).toEqual([[`fdaa::2`, `fdaa::3`]]);
    });

    test(`tells the listeners only when the machine set moved`, async () => {
        const { peers, changes } = world([[`fdaa::2`], [`fdaa::2`], [`fdaa::2`, `fdaa::3`], [`fdaa::3`]]);
        await peers.refresh();
        await peers.refresh();
        await peers.refresh();
        await peers.refresh();

        expect(changes).toEqual([[`fdaa::2`], [`fdaa::2`, `fdaa::3`], [`fdaa::3`]]);
    });

    /* A DNS blip is not an empty app. Forgetting every peer on one failed lookup would 502 every request that
     * was being forwarded a second ago, for the length of the blip, on every machine at once. */
    test(`keeps the last answer through a failed lookup`, async () => {
        const { peers, log, changes } = world([[`fdaa::2`], new Error(`ENOTFOUND`), [`fdaa::2`]]);
        await peers.refresh();
        await peers.refresh();

        expect(peers.current().map((peer) => peer.host)).toEqual([`fdaa::2`]);
        expect(changes).toEqual([[`fdaa::2`]]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`keeping the last answer`), expect.any(Error));
    });

    test(`says nothing after close`, async () => {
        const { peers, changes } = world([[`fdaa::2`]]);
        peers.close();
        await peers.refresh();

        expect(peers.current()).toEqual([]);
        expect(changes).toEqual([]);
    });
});
