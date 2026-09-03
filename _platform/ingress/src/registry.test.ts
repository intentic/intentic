import type { IngressSession } from "@intentic/sandbox-contract/ingress-protocol";
import { describe, expect, test, vi } from "vitest";
import { createTunnelRegistry, DISPLACED_CODE } from "./registry.js";

// A session is opaque here: the registry only ever holds one and compares it by identity.
const session = (): IngressSession =>
    ({ forwardRequest: vi.fn(), forwardUpgrade: vi.fn(), close: vi.fn() }) as unknown as IngressSession;

describe(`createTunnelRegistry`, () => {
    test(`routes a sandbox to the tunnel that registered it`, () => {
        const registry = createTunnelRegistry();
        const first = session();
        registry.register(`abcdef012345`, { session: first, close: vi.fn() });

        expect(registry.lookup(`abcdef012345`)).toBe(first);
        expect(registry.lookup(`000000000000`)).toBeUndefined();
        expect(registry.size()).toBe(1);
    });

    /* DISPLACEMENT: the newest dial wins, always. This is what makes a recreated container heal itself instead
     * of fighting a registration its dead predecessor still held. */
    test(`a second tunnel takes the id and closes the first`, () => {
        const registry = createTunnelRegistry();
        const older = session();
        const olderClose = vi.fn();
        const newer = session();
        registry.register(`abcdef012345`, { session: older, close: olderClose });

        expect(registry.register(`abcdef012345`, { session: newer, close: vi.fn() })).toBe(true);
        expect(olderClose).toHaveBeenCalledWith(DISPLACED_CODE, expect.stringContaining(`displaced`));
        expect(older.close).toHaveBeenCalledTimes(1);
        expect(registry.lookup(`abcdef012345`)).toBe(newer);
        expect(registry.size()).toBe(1);
    });

    /* THE ONE THAT IS EASY TO GET WRONG. A displaced session's close handler fires AFTER its replacement has
     * registered, so an unguarded delete hands the new container an id that routes nowhere — every request to
     * that sandbox 502s with a perfectly healthy tunnel attached, until it happens to redial. */
    test(`a displaced session's teardown cannot evict its replacement`, () => {
        const registry = createTunnelRegistry();
        const older = session();
        const newer = session();
        registry.register(`abcdef012345`, { session: older, close: vi.fn() });
        registry.register(`abcdef012345`, { session: newer, close: vi.fn() });

        registry.unregister(`abcdef012345`, older);

        expect(registry.lookup(`abcdef012345`)).toBe(newer);
    });

    test(`the session that still holds the id gives it up`, () => {
        const registry = createTunnelRegistry();
        const only = session();
        registry.register(`abcdef012345`, { session: only, close: vi.fn() });

        registry.unregister(`abcdef012345`, only);

        expect(registry.lookup(`abcdef012345`)).toBeUndefined();
        expect(registry.size()).toBe(0);
    });

    test(`registering the first tunnel for an id displaces nothing`, () => {
        const registry = createTunnelRegistry();
        expect(registry.register(`abcdef012345`, { session: session(), close: vi.fn() })).toBe(false);
        expect(registry.ids()).toEqual([`abcdef012345`]);
    });
});

describe(`the registry and the cluster`, () => {
    /* The cluster hears every local arrival and departure so the peers can be told (cluster.ts). A
     * displacement is neither: the id did not leave the cluster, it moved, and the peer that took it is the
     * one announcing. */
    test(`reports register and unregister, and not a displacement`, () => {
        const onChange = vi.fn();
        const registry = createTunnelRegistry({ onChange });
        const held = session();
        registry.register(`abcdef012345`, { session: held, close: vi.fn() });
        registry.unregister(`abcdef012345`, held);

        expect(onChange.mock.calls).toEqual([[{ kind: `register`, sandboxId: `abcdef012345` }], [{ kind: `unregister`, sandboxId: `abcdef012345` }]]);

        registry.register(`abcdef012345`, { session: session(), close: vi.fn() });
        onChange.mockClear();
        expect(registry.displace(`abcdef012345`, `moved`)).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
    });

    // Newest wins across machines too: a peer's delta closes the local session with the same code a local
    // displacement would, so the daemon's reconnect loop reads both the same way.
    test(`displace closes and drops the local session, and says whether there was one`, () => {
        const registry = createTunnelRegistry();
        const held = session();
        const close = vi.fn();
        registry.register(`abcdef012345`, { session: held, close });

        expect(registry.displace(`abcdef012345`, `displaced by a newer tunnel on peer-b`)).toBe(true);
        expect(close).toHaveBeenCalledWith(DISPLACED_CODE, `displaced by a newer tunnel on peer-b`);
        expect(held.close).toHaveBeenCalledTimes(1);
        expect(registry.lookup(`abcdef012345`)).toBeUndefined();
        // The old session's own close handler runs after: it must find nothing of its own to remove.
        registry.unregister(`abcdef012345`, held);
        expect(registry.displace(`abcdef012345`, `again`)).toBe(false);
    });
});
