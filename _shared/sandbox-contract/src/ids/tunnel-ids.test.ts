import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { PORT_SLOT_COUNT, portSlotsFromToken, sandboxIdFromToken } from "./tunnel-ids.js";

// The digests every language spells again (ic's util.rs, sandbox-run's Web Crypto twin) are held to the
// run contract's names.fixture.json, which each of them is tested against. SAFETY: the fixture is this repository's own
// file; the assertions below fail on any field it lacks.
const SHARED = JSON.parse(readFileSync(join(repoRoot(import.meta.url), "_shared/sandbox-run/src/names.fixture.json"), "utf8")) as {
    readonly sandboxIds: { readonly vectors: { readonly token: string; readonly id: string }[] };
};

const TOKEN = "connect-token-one";
const OTHER = "connect-token-two";

test("the sandbox id is a stable 12-hex digest of the connect token, and absent without one", () => {
    expect(sandboxIdFromToken(TOKEN)).toMatch(/^[0-9a-f]{12}$/);
    expect(sandboxIdFromToken(TOKEN)).toBe(sandboxIdFromToken(TOKEN));
    expect(sandboxIdFromToken(OTHER)).not.toBe(sandboxIdFromToken(TOKEN));
    expect(sandboxIdFromToken("")).toBeUndefined();
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

test.each(SHARED.sandboxIds.vectors)("the sandbox id of $token is $id, the digest ic and the browser derive too", ({ token, id }) => {
    expect(sandboxIdFromToken(token)).toBe(id);
});
