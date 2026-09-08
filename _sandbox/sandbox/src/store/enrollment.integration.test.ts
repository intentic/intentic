import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { enrollments, pairings } from "./enrollment.js";

// Pins the shared mechanic four doors use, not any one door's specifics: which pairings get written down at all, and
// that an enrollment file never holds a usable credential.

const root = (): string => mkdtempSync(join(tmpdir(), "enrollment-"));
const burnsIn = (historyRoot: string): string => join(historyRoot, "pair-consumed.json");

describe("pairings", () => {
    // `replayable` is a parameter, not a convention: a token that only ever lived in this process is unreplayable once
    // it leaves the map, so recording its digest would cost a file for security it already has.
    it("leaves no trace of a pairing that never left this process", async () => {
        const historyRoot = root();
        const pending = pairings<string>(burnsIn(historyRoot));
        const { token } = pending.mint("laptop");

        expect(await pending.redeem(token)).toBe("laptop");
        expect(await pending.redeem(token)).toBeUndefined();
        expect(existsSync(burnsIn(historyRoot))).toBe(false);
    });

    // A token written somewhere immortal (env, `docker inspect`, replayed into every rebuild) needs its digest on
    // /history, since forgetting it would turn a short window into a permanent key.
    it("burns a replayable pairing, and the burn outlives the daemon that spent it", async () => {
        const historyRoot = root();
        const pending = pairings<string>(burnsIn(historyRoot));
        const { token } = pending.mint("rig", { replayable: true });

        expect(await pending.redeem(token)).toBe("rig");
        const written = JSON.parse(await readFile(burnsIn(historyRoot), "utf8")) as { digests: string[] };
        expect(written.digests).toHaveLength(1);
        // Digests only, never the token: the file proves something was spent without holding anything that could spend
        // it.
        expect(written.digests[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(await readFile(burnsIn(historyRoot), "utf8")).not.toContain(token);

        expect(await pairings<string>(burnsIn(historyRoot)).arm(token, "rig")).toBe(false);
    });

    // Two daemons can share one /history (an overlapping restart, a dev sandbox on the same volume), so "not in my map"
    // isn't "never spent"; redemption checks the burn list too.
    it("refuses a pairing whose digest is already burned, even while its own map still holds it", async () => {
        const historyRoot = root();
        const mine = pairings<string>(burnsIn(historyRoot));
        const theirs = pairings<string>(burnsIn(historyRoot));

        expect(await mine.arm("from-the-env", "rig")).toBe(true);
        expect(await theirs.arm("from-the-env", "rig")).toBe(true);
        expect(await theirs.redeem("from-the-env")).toBe("rig");

        // The digest on /history decides, not this table's own map.
        expect(mine.peek("from-the-env")).toBe("rig");
        expect(await mine.redeem("from-the-env")).toBeUndefined();
    });

    // A door with no burn file can't tell a fresh token from a replayed one, so it refuses pre-agreed tokens outright;
    // treating a missing file as "nothing spent" would be backwards.
    it("refuses to arm a pre-agreed token at a door that keeps no burn list", async () => {
        const pending = pairings<string>();
        expect(await pending.arm("from-the-env", "laptop")).toBe(false);
        expect(pending.peek("from-the-env")).toBeUndefined();
        // Minting and redeeming still work; only pre-agreed (`arm`) tokens need the burn list.
        expect(await pending.redeem(pending.mint("laptop").token)).toBe("laptop");
    });

    it("is not a pairing when the token is empty", async () => {
        const pending = pairings<string>(burnsIn(root()));
        expect(await pending.arm("", "laptop")).toBe(false);
        expect(await pending.redeem("")).toBeUndefined();
    });
});

describe("enrollments", () => {
    const store = (historyRoot: string) =>
        enrollments({ path: join(historyRoot, "enrollments.json"), key: "things", prefix: "itk_", extra: { host: z.string().optional() } });

    it("writes digests, never the token it hands back", async () => {
        const historyRoot = root();
        const token = await store(historyRoot).issue("rig", {});

        const written = await readFile(join(historyRoot, "enrollments.json"), "utf8");
        expect(written).toContain("rig");
        expect(written).not.toContain(token);
        expect(JSON.parse(written)).toMatchObject({ things: [{ id: "rig", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    });

    // Re-issuing replaces, not adds a second key: the old token stops verifying the moment the new one lands, so
    // re-running an installer is safe.
    it("rotates on re-issue and survives the daemon that issued it", async () => {
        const historyRoot = root();
        const first = await store(historyRoot).issue("rig", {});
        const second = await store(historyRoot).issue("rig", {});

        const rebooted = store(historyRoot);
        expect(await rebooted.verify(second)).toBe("rig");
        expect(await rebooted.verify(first)).toBeUndefined();
        expect(await rebooted.verify("")).toBeUndefined();
        expect(await rebooted.list()).toEqual([{ id: "rig" }]);
    });

    // `list` never returns the digest or the timestamp; neither is any caller's business.
    it("carries a door's own fields and keeps the digest out of what it lists", async () => {
        const historyRoot = root();
        const records = store(historyRoot);
        await records.issue("rig", { host: "rog" });
        await records.issue("hand-made", {});

        expect((await records.list()).toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
            { id: "hand-made" },
            { id: "rig", host: "rog" },
        ]);
    });

    it("renames without disturbing the key, and revokes once", async () => {
        const historyRoot = root();
        const records = store(historyRoot);
        const token = await records.issue("rig", { host: "rog" });

        await records.rename("rig", "the-rig");
        expect(await records.verify(token)).toBe("the-rig");
        expect(await records.enrolled("rig")).toBe(false);
        expect(await records.list()).toEqual([{ id: "the-rig", host: "rog" }]);

        expect(await records.revoke("the-rig")).toBe(true);
        // A repeat revoke is a no-op that reports false, not a rewrite of the file.
        expect(await records.revoke("the-rig")).toBe(false);
        expect(await records.verify(token)).toBeUndefined();
    });
});
