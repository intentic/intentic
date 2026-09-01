import { INGRESS_GRANT_HEADER } from "@intentic/sandbox-contract/ingress-contract";
import type { IngressSessionServer } from "@intentic/sandbox-contract/ingress-protocol";
import { describe, expect, test, vi } from "vitest";
import { startIngressTunnel, startIngressTunnelWhenConfigured, tunnelUrl, type TunnelSocket } from "./ingress-tunnel.js";

/* WHAT THE RECONNECT LOOP OWES, tested against a fake socket because every property worth pinning here is
 * about WHEN it dials again, and none of them is about bytes: the protocol's own end-to-end test covers those.
 *
 * The three that matter are the three that have gone wrong in a tunnel loop before: a refused dial that
 * hammers, a displaced tunnel that flaps against its replacement, and a long-lived tunnel that reconnects at
 * the ceiling after one blip because nothing ever reset the counter.
 */

// A stand-in for `ws`: records listeners so a test can drive the socket's whole lifecycle by hand.
class FakeSocket implements TunnelSocket {
    private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
    public readonly close = vi.fn<(code?: number, reason?: string) => void>();
    public readonly terminate = vi.fn<() => void>();

    public on(event: string, listener: (...args: never[]) => void): this {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
        return this;
    }

    public emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
            (listener as (...a: unknown[]) => void)(...args);
        }
    }
}

// One dial's worth of scaffolding: the sockets handed out, the waits asked for, and a gate that holds each
// backoff open until the test lets it through.
const harness = (options?: { readonly now?: () => number }) => {
    const sockets: FakeSocket[] = [];
    const waits: number[] = [];
    const headers: Record<string, string>[] = [];
    let release: (() => void) | undefined;
    const served: IngressSessionServer = { close: vi.fn() };

    const handle = startIngressTunnel({
        url: `https://ingress.sbx.example.test`,
        grant: `ig1.payload.signature`,
        targetPort: 5173,
        log: () => undefined,
        connect: (_url, sent) => {
            headers.push(sent);
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        serve: () => Promise.resolve(served),
        delay: (ms) => {
            waits.push(ms);
            return new Promise<void>((resolve) => {
                release = resolve;
            });
        },
        // Full jitter with random() === 1 lands exactly on the ceiling, so the assertions read the schedule
        // rather than a sample from it.
        random: () => 1,
        ...(options?.now === undefined ? {} : { now: options.now }),
    });

    // Let the pending microtasks (the async open handler, the loop's own awaits) drain.
    const settle = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- draining a microtask queue is sequential by definition
            await Promise.resolve();
        }
    };

    return { handle, sockets, waits, headers, served, settle, next: () => release?.() };
};

describe(`tunnelUrl`, () => {
    test(`derives the versioned websocket door from the edge's https address`, () => {
        expect(tunnelUrl(`https://ingress.sbx.intentic.dev`)).toBe(`wss://ingress.sbx.intentic.dev/tunnel/v1`);
    });

    // A developer's edge on plain http must not be dialled as wss, which fails in a way that reads as a
    // certificate problem rather than a scheme one.
    test(`keeps a plaintext edge plaintext`, () => {
        expect(tunnelUrl(`http://localhost:8080`)).toBe(`ws://localhost:8080/tunnel/v1`);
    });

    // The base may carry a path; the door is absolute and replaces it rather than nesting under it.
    test(`ignores a path on the base address`, () => {
        expect(tunnelUrl(`https://edge.example.test/ignored`)).toBe(`wss://edge.example.test/tunnel/v1`);
    });
});

describe(`startIngressTunnel`, () => {
    test(`presents the grant on the upgrade and serves once the socket opens`, async () => {
        const world = harness();
        expect(world.headers[0]?.[INGRESS_GRANT_HEADER]).toBe(`ig1.payload.signature`);
        expect(world.handle.connected()).toBe(false);

        world.sockets[0]?.emit(`open`);
        await world.settle();
        expect(world.handle.connected()).toBe(true);
    });

    /* A DISPLACED TUNNEL STANDS BACK. Redialing straight into 4001 is how two containers sharing a connect
     * token evict each other forever, with neither serving a request in between. */
    test(`waits a long interval when a newer tunnel takes the address`, async () => {
        const world = harness();
        world.sockets[0]?.emit(`open`);
        await world.settle();

        world.sockets[0]?.emit(`close`, 4001);
        await world.settle();
        expect(world.waits).toEqual([60_000]);
        expect(world.handle.connected()).toBe(false);
    });

    // A dial that never became a working tunnel — a bad grant, an edge that is down — must back off rather
    // than spin.
    test(`doubles the backoff while dials keep failing`, async () => {
        const world = harness();
        world.sockets[0]?.emit(`close`, 1006);
        await world.settle();
        world.next();
        await world.settle();

        world.sockets[1]?.emit(`close`, 1006);
        await world.settle();
        expect(world.waits).toEqual([2_000, 4_000]);
    });

    /* …AND A TUNNEL THAT ACTUALLY WORKED EARNS THE FLOOR BACK. Without this, a container up for a week
     * reconnects at the ceiling after one blip, because the counter still remembers a bad afternoon. */
    test(`resets the backoff after a session that lasted`, async () => {
        let clock = 0;
        const world = harness({ now: () => clock });
        world.sockets[0]?.emit(`close`, 1006);
        await world.settle();
        world.next();
        await world.settle();

        world.sockets[1]?.emit(`open`);
        await world.settle();
        clock += 120_000;
        world.sockets[1]?.emit(`close`, 1006);
        await world.settle();
        expect(world.waits).toEqual([2_000, 1_000]);
    });

    // The tunnel is this sandbox's reachability, so shutdown is the only thing that ends the loop.
    test(`stops dialling once closed`, async () => {
        const world = harness();
        world.sockets[0]?.emit(`close`, 1006);
        await world.settle();
        await world.handle.close();
        world.next();
        await world.settle();

        expect(world.sockets).toHaveLength(1);
        expect(world.handle.connected()).toBe(false);
    });
});

describe(`startIngressTunnelWhenConfigured`, () => {
    const base = { url: `https://ingress.example.test`, grant: `ig1.a.b`, targetPort: 5173, frontDoor: true };

    // Each refusal names the piece that is missing, because the three are fixed in three different places.
    test.each([
        [`no front door`, { ...base, frontDoor: false }, `front door`],
        [`no edge`, { ...base, url: `` }, `INGRESS_URL`],
        [`no grant`, { ...base, grant: `` }, `SANDBOX_GRANT`],
    ])(`%s is a loopback-only posture, not a failure`, (_name, options, reason) => {
        const log = vi.fn();
        expect(startIngressTunnelWhenConfigured({ ...options, log })).toBeUndefined();
        expect(log.mock.calls[0]?.[0]).toContain(reason);
    });
});
