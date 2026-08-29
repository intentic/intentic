import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { enrollments, pairings } from "./enrollment.js";

/* The mechanic four doors share, tested where it lives. Each door's own suite still pins what is true of that
 * door — which id a pairing enrolls, what the file is called, what the token is named on the way out — and
 * what is here is what none of them can state alone: the rule that decides which pairings are written down,
 * and the promise that an enrollment file never holds a usable credential. */

const root = (): string => mkdtempSync(join(tmpdir(), "enrollment-"));
const burnsIn = (historyRoot: string): string => join(historyRoot, "pair-consumed.json");

describe("pairings", () => {
    /* THE BURN RULE, which is the whole reason `replayable` is a parameter rather than a convention. A token
     * that only ever existed in this process is unreplayable the moment it leaves the map, and recording its
     * digest would grow a file on /history for security it already has. */
    it("leaves no trace of a pairing that never left this process", async () => {
        const historyRoot = root();
        const pending = pairings<string>(burnsIn(historyRoot));
        const { token } = pending.mint("laptop");

        expect(await pending.redeem(token)).toBe("laptop");
        expect(await pending.redeem(token)).toBeUndefined();
        expect(existsSync(burnsIn(historyRoot))).toBe(false);
    });

    /* A token written somewhere IMMORTAL is the other case: it is in the container's env, in `docker inspect`,
     * and replayed verbatim into every rebuild, so forgetting it turns a ten-minute window into a permanent
     * key. Its digest goes to /history, which outlives the container that holds the copy. */
    it("burns a replayable pairing, and the burn outlives the daemon that spent it", async () => {
        const historyRoot = root();
        const pending = pairings<string>(burnsIn(historyRoot));
        const { token } = pending.mint("rig", { replayable: true });

        expect(await pending.redeem(token)).toBe("rig");
        const written = JSON.parse(await readFile(burnsIn(historyRoot), "utf8")) as { digests: string[] };
        expect(written.digests).toHaveLength(1);
        // Digests, never the token: the file records that something was spent and holds nothing that could
        // spend anything.
        expect(written.digests[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(await readFile(burnsIn(historyRoot), "utf8")).not.toContain(token);

        expect(await pairings<string>(burnsIn(historyRoot)).arm(token, "rig")).toBe(false);
    });

    /* THE REPLAY THE MAP CANNOT SEE. Two daemons can share one /history — a dev sandbox pointed at the same
     * volume, or a restart that overlaps its predecessor — so "not in my map" is not the same question as
     * "never spent". The burn list is asked at redemption too, and it is what makes the property survive
     * somebody later adding a third way for a token to arrive. */
    it("refuses a pairing whose digest is already burned, even while its own map still holds it", async () => {
        const historyRoot = root();
        const mine = pairings<string>(burnsIn(historyRoot));
        const theirs = pairings<string>(burnsIn(historyRoot));

        expect(await mine.arm("from-the-env", "rig")).toBe(true);
        expect(await theirs.arm("from-the-env", "rig")).toBe(true);
        expect(await theirs.redeem("from-the-env")).toBe("rig");

        // Still in this table's map, and still refused: the digest on /history decides.
        expect(mine.peek("from-the-env")).toBe("rig");
        expect(await mine.redeem("from-the-env")).toBeUndefined();
    });

    /* FAIL CLOSED. A door with no burn file (webext: nobody can pre-arrange a browser's pairing) has no way to
     * tell a fresh setup token from a replayed one, so it must not accept one at all. Getting this backwards
     * would make the absence of a file read as "nothing has ever been spent". */
    it("refuses to arm a pre-agreed token at a door that keeps no burn list", async () => {
        const pending = pairings<string>();
        expect(await pending.arm("from-the-env", "laptop")).toBe(false);
        expect(pending.peek("from-the-env")).toBeUndefined();
        // Minting still works: what that door has is the one way in it is supposed to have.
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

    // The one promise the file makes: it records that something is enrolled, and holds nothing that could be
    // used to present it.
    it("writes digests, never the token it hands back", async () => {
        const historyRoot = root();
        const token = await store(historyRoot).issue("rig", {});

        const written = await readFile(join(historyRoot, "enrollments.json"), "utf8");
        expect(written).toContain("rig");
        expect(written).not.toContain(token);
        expect(JSON.parse(written)).toMatchObject({ things: [{ id: "rig", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    });

    // Re-issuing is a REPLACEMENT, not a second key: whatever the far end held stops verifying the moment the
    // new token lands, which is what makes re-running an installer safe.
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

    // What a door keeps beside the digest rides along, and `list` hands back that and the id — never the
    // digest, and never the timestamp, neither of which is any caller's business.
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
        // Revoking what was never here is a no-op that says so, rather than a rewrite of the file.
        expect(await records.revoke("the-rig")).toBe(false);
        expect(await records.verify(token)).toBeUndefined();
    });
});
