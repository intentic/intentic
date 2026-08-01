import { expect, test } from "vitest";
import { hostSshIdFromToken, PORT_SLOT_COUNT, portSlotsFromToken, sandboxIdFromToken } from "./tunnel-ids.js";

const TOKEN = "connect-token-one";
const OTHER = "connect-token-two";

test("the sandbox id is a stable 12-hex digest of the connect token, and absent without one", () => {
    expect(sandboxIdFromToken(TOKEN)).toMatch(/^[0-9a-f]{12}$/);
    expect(sandboxIdFromToken(TOKEN)).toBe(sandboxIdFromToken(TOKEN));
    expect(sandboxIdFromToken(OTHER)).not.toBe(sandboxIdFromToken(TOKEN));
    expect(sandboxIdFromToken("")).toBeUndefined();
});

test("a host ssh id is salted per host, so two deploy targets never collide", () => {
    expect(hostSshIdFromToken(TOKEN, "web-1")).toMatch(/^[0-9a-f]{12}$/);
    expect(hostSshIdFromToken(TOKEN, "web-1")).not.toBe(hostSshIdFromToken(TOKEN, "web-2"));
});

test("port slots are a fixed-size pool of DNS-safe labels, stable per token", () => {
    const slots = portSlotsFromToken(TOKEN);
    // Fixed size: the pool is the cap on preview DNS records a sandbox costs the shared zone.
    expect(slots).toHaveLength(PORT_SLOT_COUNT);
    // Every label must survive as one DNS label AND pass the platform's mint filter
    // (/^(preview|port)-[a-z0-9][a-z0-9-]*$/, ≤50 chars), which `port-<slot>` has to satisfy.
    for (const slot of slots) {
        expect(slot).toMatch(/^[0-9a-f]{12}$/);
        expect(`port-${slot}`).toMatch(/^port-[a-z0-9][a-z0-9-]*$/);
        expect(`port-${slot}`.length).toBeLessThanOrEqual(50);
    }
    // Distinct, or two forwards would fight over one hostname.
    expect(new Set(slots).size).toBe(PORT_SLOT_COUNT);
    // Stable: the daemon and the platform derive these independently and must agree, and a restart has to
    // land on the records already minted rather than orphaning them.
    expect(portSlotsFromToken(TOKEN)).toEqual(slots);
});

/* The whole point of the salt. The sandbox id is public — it is the leading label of the sandbox's own URL and
 * of every preview link its owner has shared — so anything derived from the id ALONE is derivable by whoever
 * holds one of those links. Slots must not be: knowing a sandbox's id must not tell you where its forwarded
 * ports live. */
test("slots are not derivable from the sandbox id — only from the token behind it", () => {
    expect(portSlotsFromToken(OTHER)).not.toEqual(portSlotsFromToken(TOKEN));
    // No slot leaks the id it will be paired with in `port-<slot>-<sandboxId>`.
    const id = sandboxIdFromToken(TOKEN);
    expect(id).toBeDefined();
    expect(portSlotsFromToken(TOKEN)).not.toContain(id);
    // And none of them is the old fixed alphabet, which is what made the hostnames guessable.
    expect(portSlotsFromToken(TOKEN).some((slot) => slot.length === 1)).toBe(false);
});
