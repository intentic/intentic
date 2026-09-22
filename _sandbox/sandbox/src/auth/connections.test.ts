import { test, expect, mock } from "bun:test";
import { createAuthConnections } from "./connections.js";

const caller = (email: string) => ({ email, role: "maintainer" as const });

test("revokes every live transport for one identity without touching another", () => {
    const connections = createAuthConnections();
    const first = mock();
    const second = mock();
    const other = mock();
    connections.register(caller("Member@Example.com"), first);
    connections.register(caller("member@example.com"), second);
    connections.register(caller("other@example.com"), other);

    connections.revoke("MEMBER@example.com");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
});

test("unregistering is idempotent and sandbox-wide revocation closes everything still live", () => {
    const connections = createAuthConnections();
    const gone = mock();
    const live = mock();
    const unregister = connections.register(caller("gone@example.com"), gone);
    connections.register(caller("live@example.com"), live);
    unregister();
    unregister();

    connections.revoke();
    expect(gone).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(1);
    connections.revoke();
    expect(live).toHaveBeenCalledTimes(1);
});
