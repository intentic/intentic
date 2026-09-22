import type { IngressSession } from "@intentic/sandbox-contract/ingress-protocol";
import { describe, test, expect, mock } from "bun:test";
import { createTunnelRegistry, DISPLACED_CODE } from "./registry.js";

// A session is opaque here: the registry only ever holds one and compares it by identity.
const session = (): IngressSession =>
    ({ forwardRequest: mock(), forwardUpgrade: mock(), close: mock() }) as unknown as IngressSession;

describe(`createTunnelRegistry`, () => {
    test(`routes a sandbox to the tunnel that registered it`, () => {
        const registry = createTunnelRegistry();
        const first = session();
        registry.register(`abcdef012345`, { session: first, close: mock() });

        expect(registry.lookup(`abcdef012345`)).toBe(first);
        expect(registry.lookup(`000000000000`)).toBeUndefined();
        expect(registry.size()).toBe(1);
    });

    test(`a second tunnel takes the id and closes the first`, () => {
        const registry = createTunnelRegistry();
        const older = session();
        const olderClose = mock();
        const newer = session();
        registry.register(`abcdef012345`, { session: older, close: olderClose });

        expect(registry.register(`abcdef012345`, { session: newer, close: mock() })).toBe(true);
        expect(olderClose).toHaveBeenCalledWith(DISPLACED_CODE, expect.stringContaining(`displaced`));
        expect(older.close).toHaveBeenCalledTimes(1);
        expect(registry.lookup(`abcdef012345`)).toBe(newer);
        expect(registry.size()).toBe(1);
    });

    test(`a displaced session's teardown cannot evict its replacement`, () => {
        const registry = createTunnelRegistry();
        const older = session();
        const newer = session();
        registry.register(`abcdef012345`, { session: older, close: mock() });
        registry.register(`abcdef012345`, { session: newer, close: mock() });

        registry.unregister(`abcdef012345`, older);

        expect(registry.lookup(`abcdef012345`)).toBe(newer);
    });

    test(`the session that still holds the id gives it up`, () => {
        const registry = createTunnelRegistry();
        const only = session();
        registry.register(`abcdef012345`, { session: only, close: mock() });

        registry.unregister(`abcdef012345`, only);

        expect(registry.lookup(`abcdef012345`)).toBeUndefined();
        expect(registry.size()).toBe(0);
    });

    test(`registering the first tunnel for an id displaces nothing`, () => {
        const registry = createTunnelRegistry();
        expect(registry.register(`abcdef012345`, { session: session(), close: mock() })).toBe(false);
        expect(registry.ids()).toEqual([`abcdef012345`]);
    });
});

describe(`the registry and the cluster`, () => {
    test(`reports register and unregister, and not a displacement`, () => {
        const onChange = mock();
        const registry = createTunnelRegistry({ onChange });
        const held = session();
        registry.register(`abcdef012345`, { session: held, close: mock() });
        registry.unregister(`abcdef012345`, held);

        expect(onChange.mock.calls).toEqual([[{ kind: `register`, sandboxId: `abcdef012345` }], [{ kind: `unregister`, sandboxId: `abcdef012345` }]]);

        registry.register(`abcdef012345`, { session: session(), close: mock() });
        onChange.mockClear();
        expect(registry.displace(`abcdef012345`, `moved`)).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
    });

    test(`displace closes and drops the local session, and says whether there was one`, () => {
        const registry = createTunnelRegistry();
        const held = session();
        const close = mock();
        registry.register(`abcdef012345`, { session: held, close });

        expect(registry.displace(`abcdef012345`, `displaced by a newer tunnel on peer-b`)).toBe(true);
        expect(close).toHaveBeenCalledWith(DISPLACED_CODE, `displaced by a newer tunnel on peer-b`);
        expect(held.close).toHaveBeenCalledTimes(1);
        expect(registry.lookup(`abcdef012345`)).toBeUndefined();
        // Simulates the old close handler running after displacement; it finds nothing left to remove.
        registry.unregister(`abcdef012345`, held);
        expect(registry.displace(`abcdef012345`, `again`)).toBe(false);
    });
});
