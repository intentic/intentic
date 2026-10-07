import { createAuthConnections } from "./connections.js";
import type { ControlPrincipal } from "./principal.js";

const caller = (email: string) => ({ email, role: "maintainer" as const });
const token = (id: string): ControlPrincipal => ({ kind: "control", id, label: `ci ${id}`, scope: "read" });

test("revokes every live transport for one identity without touching another", () => {
    const connections = createAuthConnections();
    const first = jest.fn();
    const second = jest.fn();
    const other = jest.fn();
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
    const gone = jest.fn();
    const live = jest.fn();
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

test("every revocation is heard, lowercased, by each listener until it stops listening", () => {
    const connections = createAuthConnections();
    const heard: (string | undefined)[] = [];
    const stop = connections.onRevoke((email) => heard.push(email));
    connections.revoke("Member@Example.com");
    connections.revoke();
    stop();
    connections.revoke("later@example.com");
    expect(heard).toEqual(["member@example.com", undefined]);
});

test("revoking one control token closes only its transports, and no member's", () => {
    const connections = createAuthConnections();
    const heard: (string | undefined)[] = [];
    connections.onRevoke((email) => heard.push(email));
    const revoked = jest.fn();
    const alsoRevoked = jest.fn();
    const otherToken = jest.fn();
    const member = jest.fn();
    connections.register(token("tok-1"), revoked);
    connections.register(token("tok-1"), alsoRevoked);
    connections.register(token("tok-2"), otherToken);
    connections.register(caller("member@example.com"), member);

    connections.revokeControl("tok-1");
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(alsoRevoked).toHaveBeenCalledTimes(1);
    expect(otherToken).not.toHaveBeenCalled();
    expect(member).not.toHaveBeenCalled();
    // netd's terminals are members' only, so a token's revocation is not relayed.
    expect(heard).toEqual([]);
    connections.revokeControl("tok-1");
    expect(revoked).toHaveBeenCalledTimes(1);
});

test("a member's revocation leaves token transports open; the sandbox-wide one closes them too", () => {
    const connections = createAuthConnections();
    const member = jest.fn();
    const program = jest.fn();
    connections.register(caller("member@example.com"), member);
    // A token id shaped like an email still never matches a member's revocation.
    connections.register(token("member@example.com"), program);

    connections.revoke("member@example.com");
    expect(member).toHaveBeenCalledTimes(1);
    expect(program).not.toHaveBeenCalled();

    connections.revoke();
    expect(program).toHaveBeenCalledTimes(1);
});
