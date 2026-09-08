import { INGRESS_GRANT_HEADER } from "@intentic/sandbox-contract/ingress-contract";
import type { IngressSessionServer } from "@intentic/sandbox-contract/ingress-protocol";
import { describe, expect, test, vi } from "vitest";
import { reachPosture, startIngressTunnel, startIngressTunnelWhenConfigured, tunnelUrl, type TunnelSocket } from "./ingress-tunnel.js";

// Reconnect-loop timing against a fake socket; byte-level behavior is covered by the protocol's own test. Pins
// refused-dial backoff, displaced-tunnel standoff, and backoff reset after a stable session.

// Stand-in for `ws`; records listeners so a test can drive the socket's lifecycle by hand.
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

// One dial's worth of scaffolding: sockets handed out, waits asked for, and a gate holding each backoff open until the
// test releases it.
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
        // Full jitter with random() === 1 lands exactly on the ceiling, so assertions read the schedule directly.
        random: () => 1,
        ...(options?.now === undefined ? {} : { now: options.now }),
    });

    // Drains pending microtasks: the async open handler and the loop's own awaits.
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

    test(`keeps a plaintext edge plaintext`, () => {
        expect(tunnelUrl(`http://localhost:8080`)).toBe(`ws://localhost:8080/tunnel/v1`);
    });

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

    test(`waits a long interval when a newer tunnel takes the address`, async () => {
        const world = harness();
        world.sockets[0]?.emit(`open`);
        await world.settle();

        world.sockets[0]?.emit(`close`, 4001);
        await world.settle();
        expect(world.waits).toEqual([60_000]);
        expect(world.handle.connected()).toBe(false);
    });

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

    // Each case names the one piece missing; the three are fixed in three different places.
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
        expect(world.waits).toEqual([2_000, 2_000]);
    });

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
    const base = { url: `https://ingress.example.test`, grant: `ig1.a.b`, targetPort: 5173, frontDoor: true, vm: false };

    test.each([
        [`no front door`, { ...base, frontDoor: false }, `front door`],
        [`no edge`, { ...base, url: `` }, `INGRESS_URL`],
        [`no grant`, { ...base, grant: `` }, `SANDBOX_GRANT`],
    ])(`%s is a loopback-only posture, not a failure`, (_name, options, reason) => {
        const log = vi.fn();
        expect(startIngressTunnelWhenConfigured({ ...options, log })).toBeUndefined();
        expect(log.mock.calls[0]?.[0]).toContain(`loopback only`);
        expect(log.mock.calls[0]?.[0]).toContain(reason);
    });

    test(`a Fly machine is reached directly and dials no tunnel`, () => {
        const log = vi.fn();
        expect(startIngressTunnelWhenConfigured({ ...base, vm: true, log })).toBeUndefined();
        expect(log.mock.calls[0]?.[0]).toContain(`reachable directly`);
    });
});

describe(`reachPosture`, () => {
    const base = { url: `https://ingress.example.test`, grant: `ig1.a.b`, frontDoor: true, vm: false };

    test(`is the tunnel when every piece is there`, () => {
        expect(reachPosture(base)).toEqual({ by: `tunnel` });
    });

    test(`is direct on a Fly machine, whatever else is configured`, () => {
        expect(reachPosture({ ...base, vm: true }).by).toBe(`direct`);
        expect(reachPosture({ ...base, vm: true, grant: `` }).by).toBe(`direct`);
    });

    test(`is loopback with the reason when a tunnel's piece is missing`, () => {
        expect(reachPosture({ ...base, grant: `` })).toEqual({ by: `loopback`, reason: expect.stringContaining(`SANDBOX_GRANT`) });
    });
});
