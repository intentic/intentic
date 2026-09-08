import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// config.ts derives its paths from homedir() at import time, so point HOME at a throwaway dir before importing
// (dynamic import, after the env is set), landing the state file in temp rather than the real ~/.intentic/machine.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-config-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { readState, removePairing, setMirrorOff, updateState, upsertPairing } = await import("./config.js");
const { rm, writeFile } = await import("node:fs/promises");
const { agentHome } = await import("@intentic/local-agent");
const syncStatePath = join(agentHome("machine").dir, "sync.json");

const pairing = (sandboxId: string, localDir: string) => ({
    sandboxUrl: `https://${sandboxId}/`,
    sandboxId,
    mode: "sync" as const,
    localDir,
    syncToken: `ist_${sandboxId}`,
});

const local = pairing("sandbox-0738cd6b5027-intentic-dev", "/home/dev/intentic/radarsu-local-0738cd6b5027");
const web = pairing("sandbox-bce57bb9fe3b-intentic-dev", "/home/dev/intentic/radarsu-web-platform-bce57bb9fe3b");

// A fresh machine per test: remove the state file outright rather than writing an empty one through
// updateState, which reads first and would itself fail on the malformed file one test deliberately leaves behind.
beforeEach(async () => {
    await rm(syncStatePath, { force: true });
});

// The regression this whole shape exists for: pairing a second sandbox used to overwrite the one config entry,
// dropping the first sandbox's folder, ssh alias and file-sync session.
describe("upsertPairing", () => {
    it("adds a second sandbox without disturbing the first", async () => {
        await upsertPairing(local);
        await upsertPairing(web);

        expect((await readState()).pairings).toEqual([local, web]);
    });

    it("replaces the entry for a sandbox already paired, rotating its token in place", async () => {
        await upsertPairing(local);
        await upsertPairing(web);
        await upsertPairing({ ...local, syncToken: "ist_rotated" });

        const { pairings } = await readState();
        expect(pairings.map((held) => held.sandboxId)).toEqual([web.sandboxId, local.sandboxId]);
        expect(pairings.find((held) => held.sandboxId === local.sandboxId)?.syncToken).toBe("ist_rotated");
    });

    it("starts from empty on a machine that has never paired anything", async () => {
        // No state file reads as no pairings: `status` prints none and `uninstall` still strips the agent's residency,
        // rather than either dying on an ENOENT.
        await rm(syncStatePath, { force: true });
        expect((await readState()).pairings).toEqual([]);

        await upsertPairing(local);
        expect((await readState()).pairings).toEqual([local]);
    });

    it("treats a state file with missing or non-array pairings as empty", async () => {
        await writeFile(syncStatePath, JSON.stringify({}), "utf8");
        expect((await readState()).pairings).toEqual([]);

        await upsertPairing(local);
        expect((await readState()).pairings).toEqual([local]);
    });

    // A file that EXISTS and is malformed is a real fault, not an empty machine: silently starting from scratch
    // would overwrite whatever the user still had paired.
    it("propagates a state file that won't parse instead of treating it as empty", async () => {
        await writeFile(syncStatePath, "{ not json", "utf8");
        await expect(readState()).rejects.toThrow();
    });
});

describe("removePairing", () => {
    it("drops one sandbox and leaves the rest", async () => {
        await upsertPairing(local);
        await upsertPairing(web);
        await removePairing(web.sandboxId);

        expect((await readState()).pairings).toEqual([local]);
    });

    it("is a no-op for a sandbox that isn't paired", async () => {
        await upsertPairing(local);
        await removePairing("sandbox-never-paired");
        expect((await readState()).pairings).toEqual([local]);
    });
});

// The owner of this device saying "not on my localhost". Durable and per pairing, since the point is that it
// holds while the sandbox is asleep or unreachable, and a machine mirroring three sandboxes has three answers.
describe("setMirrorOff", () => {
    it("switches one pairing's mirroring off and leaves its siblings alone", async () => {
        await upsertPairing(local);
        await upsertPairing(web);

        await setMirrorOff(local.sandboxId, true);

        const { pairings } = await readState();
        expect(pairings.find((held) => held.sandboxId === local.sandboxId)?.mirrorOff).toBe(true);
        expect(pairings.find((held) => held.sandboxId === web.sandboxId)).toEqual(web);
    });

    // Back on is an ABSENT flag rather than `false`, so a pairing never switched off and one switched back on are
    // the same record.
    it("clears the flag rather than storing a false", async () => {
        await upsertPairing(local);
        await setMirrorOff(local.sandboxId, true);
        await setMirrorOff(local.sandboxId, false);

        expect((await readState()).pairings).toEqual([local]);
    });

    it("keeps file sync's own fields untouched: this stops forwards and nothing else", async () => {
        await upsertPairing(local);
        await setMirrorOff(local.sandboxId, true);

        const held = (await readState()).pairings[0];
        expect(held?.localDir).toBe(local.localDir);
        expect(held?.syncToken).toBe(local.syncToken);
    });
});

// Every mutation is targeted: it maps over the pairings it isn't changing rather than writing a whole state the
// caller built earlier, bounding a lost update to one tick's port baseline rather than a sibling's whole
// pairing. Not cross-process exclusion: `setup` stops the watcher before writing, which is what actually keeps
// the two apart.
describe("updateState", () => {
    it("stamps one pairing's mirrored ports and leaves its siblings byte-identical", async () => {
        await upsertPairing(local);
        await upsertPairing(web);

        await updateState((state) => ({
            pairings: state.pairings.map((held) =>
                held.sandboxId === local.sandboxId ? { ...held, mirroredPorts: [{ port: 8787, host: "127.0.0.1" as const }] } : held,
            ),
        }));

        const { pairings } = await readState();
        expect(pairings.find((held) => held.sandboxId === local.sandboxId)?.mirroredPorts).toEqual([{ port: 8787, host: "127.0.0.1" }]);
        expect(pairings.find((held) => held.sandboxId === web.sandboxId)).toEqual(web);
    });
});
