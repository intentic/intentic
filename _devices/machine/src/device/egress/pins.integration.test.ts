import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressOwnerKeys } from "@intentic/sandbox-contract/schemas/egress";
import { type EgressPin, egressPinStore } from "./pins.js";

/* The pin store on a real disk: keyed by slug and sandbox id, one pin per slug, reset by slug, and an unreadable file
   refused rather than read as nothing pinned. */

let dir = "";
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "egress-pins-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const owner: EgressOwnerKeys = { rpId: "app.intentic.dev", origins: ["https://app.intentic.dev"], keys: [{ id: "a2V5", alg: -7, jwk: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" } }] };
const pin = (slug: string, sandboxId: string | null): EgressPin => ({ slug, sandboxId, owner, counters: {}, pinnedAt: 1, pinnedBy: "https://box.example" });

test("a pin is found by slug and sandbox id, replaced per slug, and reset by slug", async () => {
    const store = egressPinStore(join(dir, "pins.json"), dir);
    await store.write(pin("nas-box", "a1"));
    await store.write(pin("other", null));
    expect(await store.read({ slug: "nas-box", sandboxId: "a1" })).toEqual(pin("nas-box", "a1"));
    expect(await store.read({ slug: "nas-box", sandboxId: "b2" })).toBeUndefined();
    expect(await store.read({ slug: "other", sandboxId: null })).toEqual(pin("other", null));
    // The sandbox made again under its name: its pin replaces the earlier one's.
    await store.write(pin("nas-box", "b2"));
    expect(await store.list("nas-box")).toEqual([pin("nas-box", "b2")]);
    expect(await store.reset("nas-box")).toBe(1);
    expect(await store.list()).toEqual([pin("other", null)]);
    if (process.platform !== "win32") {
        expect((await stat(join(dir, "pins.json"))).mode & 0o777).toBe(0o600);
    }
});

test("a file that does not read as pins is refused, and never written over", async () => {
    const path = join(dir, "pins.json");
    await writeFile(path, "{ torn");
    const store = egressPinStore(path, dir);
    await expect(store.read({ slug: "nas-box", sandboxId: "a1" })).rejects.toThrow("does not read as this agent's passkey pins");
    await expect(store.write(pin("nas-box", "a1"))).rejects.toThrow("does not read");
    expect(await readFile(path, "utf8")).toBe("{ torn");
});
