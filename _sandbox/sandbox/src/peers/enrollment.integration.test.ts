import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HOST_CARD_RULE } from "../hosts/host-peer.js";
import { enrollments, HostEnrollmentFieldsSchema, pairings } from "./enrollment.js";

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
        // Store digests without tokens so enrollment evidence cannot spend again.
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
        expect(await rebooted.verify(second)).toEqual({ kind: "enrolled", id: "rig", card: "rig" });
        expect(await rebooted.verify(first)).toEqual({ kind: "unknown" });
        expect(await rebooted.verify("")).toEqual({ kind: "unknown" });
        expect(await rebooted.list()).toEqual([{ id: "rig", card: "rig" }]);
    });

    // `list` never returns the digest or the timestamp; neither is any caller's business.
    it("carries a door's own fields and keeps the digest out of what it lists", async () => {
        const historyRoot = root();
        const records = store(historyRoot);
        await records.issue("rig", { host: "rog" });
        await records.issue("hand-made", {});

        expect((await records.list()).toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
            { id: "hand-made", card: "hand-made" },
            { id: "rig", card: "rig", host: "rog" },
        ]);
    });

    // The distinction the doors above this rest on. json-file.ts answers an unparseable manifest with the same empty
    // fallback an absent one gets, so a `verify` that read through it could only say "not enrolled" — and every door
    // spends that answer by telling the peer its credential is dead. An absent file stays `unknown`: nothing was ever
    // enrolled there, which is a fact and not a fault.
    it("separates a manifest it could not read from one that holds no such token", async () => {
        const historyRoot = root();
        const records = store(historyRoot);
        const token = await records.issue("rig", {});
        expect(await records.verify(token)).toEqual({ kind: "enrolled", id: "rig", card: "rig" });

        await writeFile(join(historyRoot, "enrollments.json"), "{ this is not json");
        expect(await store(historyRoot).verify(token)).toEqual({ kind: "unreadable", detail: "the file is not valid JSON" });

        await rm(join(historyRoot, "enrollments.json"));
        expect(await store(historyRoot).verify(token)).toEqual({ kind: "unknown" });
    });

    it("renames without disturbing the key, and revokes once", async () => {
        const historyRoot = root();
        const records = store(historyRoot);
        const token = await records.issue("rig", { host: "rog" });

        expect(await records.relabelCard("rig", "the-rig")).toEqual([{ from: "rig", to: "the-rig" }]);
        expect(await records.verify(token)).toEqual({ kind: "enrolled", id: "the-rig", card: "the-rig" });
        expect(await records.enrolled("rig")).toBe(false);
        expect(await records.list()).toEqual([{ id: "the-rig", card: "the-rig", host: "rog" }]);

        expect(await records.revoke("the-rig")).toBe(true);
        // A repeat revoke is a no-op that reports false, not a rewrite of the file.
        expect(await records.revoke("the-rig")).toBe(false);
        expect(await records.verify(token)).toEqual({ kind: "unknown" });
    });
});

// THE HOSTS DOOR'S RECORDS: one computer's OS installs, each naming the card that lends it, so a card is removed or
// renamed in one write over the records that say so, never a loop that re-splits ids and rewrites the file per entry.
describe("host enrollments", () => {
    const HOSTS_FILE = "host-enrollments.json";
    const hosts = (historyRoot: string) =>
        enrollments({ path: join(historyRoot, HOSTS_FILE), key: "hosts", prefix: "iht_", extra: HostEnrollmentFieldsSchema.shape, card: HOST_CARD_RULE });
    // Whether an act rewrote the file: 1 or 0, since one act is at most one write here.
    const writes = async (historyRoot: string, act: () => Promise<unknown>): Promise<number> => {
        const before = await readFile(join(historyRoot, HOSTS_FILE), "utf8");
        await act();
        return (await readFile(join(historyRoot, HOSTS_FILE), "utf8")) === before ? 0 : 1;
    };

    it("relabels every environment of a card in one write, the connection keys following the label", async () => {
        const historyRoot = root();
        const records = hosts(historyRoot);
        const windows = await records.issue("rog", HOST_CARD_RULE.pairing("rog"));
        const arch = await records.issue("rog::wsl:Arch", HOST_CARD_RULE.pairing("rog::wsl:Arch"));
        await records.issue("omen", HOST_CARD_RULE.pairing("omen"));

        let moved: readonly { from: string; to: string }[] = [];
        expect(await writes(historyRoot, async () => (moved = await records.relabelCard("rog", "desk")))).toBe(1);
        expect(moved).toEqual([
            { from: "rog", to: "desk" },
            { from: "rog::wsl:Arch", to: "desk::wsl:Arch" },
        ]);
        // The keys still verify: a rename is a label, not a re-pairing. The machine id derived from the old card stays
        // until the agent says its own, since it names a computer, not a card.
        expect(await records.verify(windows)).toEqual({ kind: "enrolled", id: "desk", card: "desk" });
        expect(await records.verify(arch)).toEqual({ kind: "enrolled", id: "desk::wsl:Arch", card: "desk" });
        expect((await records.list()).find((entry) => entry.id === "desk::wsl:Arch")).toEqual({
            id: "desk::wsl:Arch",
            card: "desk",
            environment: "wsl:Arch",
            machineId: "card:rog",
        });
    });

    it("revokes a whole card in one write and answers exactly the connections it dropped", async () => {
        const historyRoot = root();
        const records = hosts(historyRoot);
        await records.issue("rog", HOST_CARD_RULE.pairing("rog"));
        await records.issue("rog::wsl:Arch", HOST_CARD_RULE.pairing("rog::wsl:Arch"));
        const omen = await records.issue("omen", HOST_CARD_RULE.pairing("omen"));

        let dropped: readonly string[] = [];
        expect(await writes(historyRoot, async () => (dropped = await records.revokeCard("rog")))).toBe(1);
        expect(dropped).toEqual(["rog", "rog::wsl:Arch"]);
        expect(await records.verify(omen)).toEqual({ kind: "enrolled", id: "omen", card: "omen" });
        // Nothing of that card left: a second revoke writes nothing and drops nothing.
        expect(await writes(historyRoot, async () => (dropped = await records.revokeCard("rog")))).toBe(0);
        expect(dropped).toEqual([]);
    });

    it("records the machine an agent says it is on, once", async () => {
        const historyRoot = root();
        const records = hosts(historyRoot);
        await records.issue("rog", HOST_CARD_RULE.pairing("rog"));
        expect(await writes(historyRoot, () => records.amend("rog", { machineId: "m-0123456789ab" }))).toBe(1);
        expect(await writes(historyRoot, () => records.amend("rog", { machineId: "m-0123456789ab" }))).toBe(0);
        expect((await records.list())[0]).toMatchObject({ card: "rog", environment: "native", machineId: "m-0123456789ab" });
    });

    // An enrollment written before its card and environment were fields spelled both in its id, and it keeps working:
    // the same token, now a record that says its card, its environment, and the card's derived machine id.
    it("reads an enrollment that only spelled its card in its id", async () => {
        const historyRoot = root();
        const earlier = hosts(historyRoot);
        const token = await earlier.issue("rog::wsl:Arch", HOST_CARD_RULE.pairing("rog::wsl:Arch"));
        const written = JSON.parse(await readFile(join(historyRoot, HOSTS_FILE), "utf8")) as { hosts: Record<string, unknown>[] };
        const legacy = written.hosts.map(({ id, hash, enrolledAt }) => ({ id, hash, enrolledAt }));
        await writeFile(join(historyRoot, HOSTS_FILE), JSON.stringify({ hosts: legacy }));

        const records = hosts(historyRoot);
        expect(await records.verify(token)).toEqual({ kind: "enrolled", id: "rog::wsl:Arch", card: "rog" });
        expect(await records.list()).toEqual([{ id: "rog::wsl:Arch", card: "rog", environment: "wsl:Arch", machineId: "card:rog" }]);
    });
});
