import { expect, test, vi } from "vitest";
import { createAuthConnections } from "./connections.js";

const caller = (email: string) => ({ email, role: "maintainer" as const });

test("revokes every live transport for one identity without touching another", () => {
    const connections = createAuthConnections();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    connections.register(caller("Member@Example.com"), first);
    connections.register(caller("member@example.com"), second);
    connections.register(caller("other@example.com"), other);

    connections.revoke("MEMBER@example.com");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
});

test("unregistering is idempotent and sandbox-wide revocation closes everything still live", () => {
    const connections = createAuthConnections();
    const gone = vi.fn();
    const live = vi.fn();
    const unregister = connections.register(caller("gone@example.com"), gone);
    connections.register(caller("live@example.com"), live);
    unregister();
    unregister();

    connections.revoke();
    expect(gone).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledOnce();
    connections.revoke();
    expect(live).toHaveBeenCalledOnce();
});
