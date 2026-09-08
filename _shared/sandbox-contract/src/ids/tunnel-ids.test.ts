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
    expect(slots).toHaveLength(PORT_SLOT_COUNT);
    for (const slot of slots) {
        expect(slot).toMatch(/^[0-9a-f]{12}$/);
        expect(`port-${slot}`).toMatch(/^port-[a-z0-9][a-z0-9-]*$/);
        expect(`port-${slot}`.length).toBeLessThanOrEqual(50);
    }
    expect(new Set(slots).size).toBe(PORT_SLOT_COUNT);
    expect(portSlotsFromToken(TOKEN)).toEqual(slots);
});

test("slots are not derivable from the sandbox id: only from the token behind it", () => {
    expect(portSlotsFromToken(OTHER)).not.toEqual(portSlotsFromToken(TOKEN));
    const id = sandboxIdFromToken(TOKEN);
    // Guards a false pass: `not.toContain(undefined)` holds for any slot list, even from a broken id function.
    expect(id).toEqual(expect.any(String));
    expect(portSlotsFromToken(TOKEN)).not.toContain(id);
    expect(portSlotsFromToken(TOKEN).some((slot) => slot.length === 1)).toBe(false);
});
