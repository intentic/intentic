import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pairing } from "../config.js";

/* FILE SYNC RUNS OR HOLDS STILL BY ONE RULE (holds.ts): what holds it is read off the pairing's facts, and every pass
   makes Mutagen agree. Each case here is a way sync was found paused with nothing left to lift it, or resumed under a
   pause somebody still meant, before a pause was a fact rather than a marker beside Mutagen's own state. On a throwaway
   home, since config.ts fixes its paths at import time; Mutagen is a shell script that keeps each session's state. */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "holds-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { baseDir } = await import("../../config.js");
const { pairingSlugs, readState, setOwnerPaused, setUnreachableSince, upsertPairing } = await import("../config.js");
const {
    holdSessions,
    holdsSync,
    markOwnerPausesAdopted,
    PROBATION_HOLD_MS,
    recordOf,
    RELEASE_FORWARDS_MS,
    shouldReleaseForwards,
    swapStep,
    syncHeld,
    syncHolds,
    UNREACHABLE_HOLD_MS,
} = await import("../holds.js");
const { resumeSessions } = await import("../mutagen.js");
const { holdSyncDuringSwaps } = await import("../mirror.js");
const { sandboxAnswered, sandboxSaidGone } = await import("../gone-watch.js");

// (2026-10-19) A RESUME HAS TO TAKE. After a rebuild the owner kept finding a sandbox's file sync
// paused, the log saying the swap was settled and file sync resumed. Mutagen's `sync resume a b` stops at the first
// session that cannot connect, which right after a swap is the usual case, and leaves the rest paused; the watcher took
// its exit code for the answer and dropped its mark either way. Here Mutagen is a shell script that behaves as 0.18.1's
// does: a resume marks its session unpaused first and fails afterwards when it cannot connect, and one call over several
// sessions stops at the first that failed.
const SANDBOX = "sandbox-82789f4106b4-example-com";
const RESUMING_URL = "https://sandbox-82789f4106b4.example.com";
const MAIN = `intentic-${SANDBOX}`;
const STATE = `intentic-${SANDBOX}-state`;

interface StatefulMutagen {
    readonly path: string;
    // Every resume and pause it was asked for, one line per call, its sessions after the verb.
    readonly calls: () => Promise<string[]>;
    readonly paused: (name: string) => Promise<boolean>;
    // How the next resumes go: `unreachable` sessions are unpaused and then fail to connect, as against a sandbox still
    // coming up; `untaken` ones are never reached at all (a daemon that did not answer in time) and stay paused.
    readonly set: (behaviour: { readonly unreachable?: readonly string[]; readonly untaken?: readonly string[] }) => Promise<void>;
}

const statefulMutagen = async (sessions: readonly string[], paused: readonly string[] = []): Promise<StatefulMutagen> => {
    const dir = mkdtempSync(join(tmpdir(), "fake-mutagen-"));
    const state = join(dir, "state");
    await mkdir(state);
    for (const name of sessions) {
        await writeFile(join(state, name), paused.includes(name) ? "paused" : "running");
    }
    await writeFile(join(dir, "unreachable"), "");
    await writeFile(join(dir, "untaken"), "");
    const path = join(dir, "mutagen");
    await writeFile(
        path,
        `#!/bin/sh
S=${state}
if [ "$2" = "list" ]; then
  if [ "$4" = "{{json .}}" ]; then
    out="["; sep=""
    for f in "$S"/*; do n=$(basename "$f"); p=false; [ "$(cat "$f")" = paused ] && p=true; out="$out$sep{\\"name\\":\\"$n\\",\\"paused\\":$p}"; sep=","; done
    echo "$out]"
  else
    ls "$S" | tr '\\n' ' '; echo
  fi
  exit 0
fi
verb=$2; shift 2
echo "$verb $*" >> ${dir}/calls
for n in "$@"; do
  if [ "$verb" = pause ]; then echo paused > "$S/$n"; continue; fi
  grep -qx "$n" ${dir}/untaken && { echo "unable to resume session: timed out" >&2; exit 1; }
  echo running > "$S/$n"
  grep -qx "$n" ${dir}/unreachable && { echo "unable to resume session: unable to connect to beta" >&2; exit 1; }
done
exit 0
`,
        { mode: 0o755 },
    );
    return {
        path,
        calls: async () => (await readFile(join(dir, "calls"), "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
        paused: async (name) => (await readFile(join(state, name), "utf8")).trim() === "paused",
        set: async ({ unreachable = [], untaken = [] }) => {
            await writeFile(join(dir, "unreachable"), unreachable.map((name) => `${name}\n`).join(""));
            await writeFile(join(dir, "untaken"), untaken.map((name) => `${name}\n`).join(""));
        },
    };
};

const pairingNow = async () => (await readState()).pairings.find((pairing) => pairing.sandboxId === SANDBOX);
const pairings = async () => (await readState()).pairings;
const quiet = (): undefined => undefined;
const adopted = join(baseDir, "sync-owner-pauses-adopted");

const pairResuming = async (): Promise<void> => {
    await upsertPairing({ sandboxUrl: RESUMING_URL, sandboxId: SANDBOX, mode: "sync", syncToken: "ist_x", localDir: join(tmpdir(), "folder") });
};

beforeEach(async () => {
    await rm(join(baseDir, "sync.json"), { force: true });
    await pairResuming();
    // Every case but the adoption's runs on a machine past it: a paused session nothing holds is one to resume.
    await markOwnerPausesAdopted();
});

describe("resumeSessions", () => {

    it("resumes each session in a call of its own, so one that cannot reach the sandbox leaves the other's resume alone", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE], [MAIN, STATE]);
        await mutagen.set({ unreachable: [STATE, MAIN] });
        expect(await resumeSessions(mutagen.path, [STATE, MAIN])).toBe(true);
        expect(await mutagen.calls()).toEqual([`resume ${STATE}`, `resume ${MAIN}`]);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });

    it("reads the pause back rather than trusting the exit code: a resume Mutagen never took is no resume", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE], [MAIN, STATE]);
        await mutagen.set({ untaken: [MAIN] });
        expect(await resumeSessions(mutagen.path, [MAIN, STATE])).toBe(false);
        expect(await mutagen.paused(STATE)).toBe(false);
    });
});

describe("a swap", () => {
    // The record ic keeps while it swaps the sandbox on this machine, by the slug its hostname gives it.
    const cutover = async () => await Promise.resolve([{ slug: "sandbox-82789f4106b4", phase: "cutover" }]);
    const settled = async () => await Promise.resolve([]);

    // fair-moth (2026-10-19): after a rebuild sync stayed paused, the log saying it had resumed.
    it("holds file sync still, and once settled resumes it pass after pass until Mutagen takes it", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE]);
        const said: string[] = [];
        const say = (line: string): void => void said.push(line);

        await holdSyncDuringSwaps(await pairings(), new Map(), say, cutover);
        expect((await pairingNow())?.swapSince).toBeTypeOf("number");
        await holdSessions(mutagen.path, await pairings(), say);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([true, true]);

        await holdSyncDuringSwaps(await pairings(), new Map(), say, settled);
        expect((await pairingNow())?.swapSince).toBeUndefined();
        // Mutagen does not take the resume of the workspace session this pass: the next pass tries again.
        await mutagen.set({ untaken: [MAIN] });
        expect([...(await holdSessions(mutagen.path, await pairings(), say))]).toEqual([SANDBOX]);
        expect(said.at(-1)).toContain("did not take the resume");
        expect(await mutagen.paused(MAIN)).toBe(true);

        await mutagen.set({});
        expect([...(await holdSessions(mutagen.path, await pairings(), say))]).toEqual([]);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });

    it("resumes both sessions when the sandbox is not answering yet as the swap settles", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE]);
        await holdSyncDuringSwaps(await pairings(), new Map(), quiet, cutover);
        await holdSessions(mutagen.path, await pairings(), quiet);
        await mutagen.set({ unreachable: [MAIN, STATE] });
        await holdSyncDuringSwaps(await pairings(), new Map(), quiet, settled);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });

    // A rebuild must not flip a pause the owner made: the swap's settling lifts the swap's hold, not the owner's.
    it("never resumes what the owner paused, before it or during it", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE]);
        await setOwnerPaused(SANDBOX, 1);
        await holdSessions(mutagen.path, await pairings(), quiet);
        await holdSyncDuringSwaps(await pairings(), new Map(), quiet, cutover);
        await holdSessions(mutagen.path, await pairings(), quiet);
        await holdSyncDuringSwaps(await pairings(), new Map(), quiet, settled);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([true, true]);

        await setOwnerPaused(SANDBOX, undefined);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });
});

describe("a sandbox said to be gone", () => {
    const fate = { releaseForwards: async () => await Promise.resolve(), say: quiet };

    // Before, the pause outlived the mark while Mutagen had not taken its resume, with a marker of its own to lift it.
    it("is held while marked, and its own answer lets it go even when Mutagen takes the resume a pass late", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE]);
        await sandboxSaidGone(fate, SANDBOX, "edge", 1_000);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect(await mutagen.paused(MAIN)).toBe(true);

        await sandboxAnswered(fate, SANDBOX);
        await mutagen.set({ untaken: [MAIN] });
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect(await mutagen.paused(MAIN)).toBe(true);
        await mutagen.set({});
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });
});

describe("a sandbox that stops answering", () => {
    it("holds file sync still past an hour, not before, and lets it go once the clock clears", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE]);
        await setUnreachableSince(SANDBOX, Date.now() - UNREACHABLE_HOLD_MS / 2);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect(await mutagen.paused(MAIN)).toBe(false);

        await setUnreachableSince(SANDBOX, Date.now() - UNREACHABLE_HOLD_MS);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([true, true]);

        await setUnreachableSince(SANDBOX, undefined);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });
});

describe("a paused session nothing holds", () => {
    // swift-cedar (2026-10-17): a reattach rewrote the pairing without the watcher's marker, and the first copy stayed
    // paused for good. With nothing to lose but a fact, nothing can be left paused without one.
    it("is resumed, once pauses from before holds were adopted", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE], [MAIN, STATE]);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });

    // A person's `sync pause` kept no record before holds: the first pass of this build takes it as theirs, once.
    it("is the owner's on the first pass of this build, and only then", async () => {
        await rm(adopted, { force: true });
        const mutagen = await statefulMutagen([MAIN, STATE], [MAIN, STATE]);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect((await pairingNow())?.ownerPausedAt).toBeTypeOf("number");
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([true, true]);
        expect(await readFile(adopted, "utf8")).not.toBe("");

        // A resume the owner asks for afterwards is theirs to make, and nothing takes it back.
        await setOwnerPaused(SANDBOX, undefined);
        await holdSessions(mutagen.path, await pairings(), quiet);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect([await mutagen.paused(MAIN), await mutagen.paused(STATE)]).toEqual([false, false]);
    });
});

describe("a session that disagrees with nothing", () => {
    it("is left alone: a pass that has nothing to change runs no pause or resume", async () => {
        const mutagen = await statefulMutagen([MAIN, STATE]);
        await holdSessions(mutagen.path, await pairings(), quiet);
        expect(await mutagen.calls()).toEqual([]);
    });
});

// ---- The rules, pure: no Mutagen, no disk. ----

/* What holds a pairing's file sync still is read off its facts alone, in one order: the owner's word first. */

const NOW = 1_800_000_000_000;
const pairing = (facts: Partial<Pairing> = {}): Pairing => ({
    sandboxUrl: "https://sandbox-0123456789ab.intentic.dev",
    sandboxId: "sandbox-0123456789ab-intentic-dev",
    mode: "sync",
    localDir: "/home/ada/intentic/work",
    ...facts,
});

test("a pairing with no fact that holds it runs", () => {
    expect(syncHolds(pairing(), NOW)).toEqual([]);
    expect(syncHeld(pairing(), NOW)).toBe(false);
});

test("every fact that holds it is named, by whose word first", () => {
    const all = pairing({
        lowDisk: { since: 1, freeBytes: 1, totalBytes: 2 },
        unreachableSince: NOW - UNREACHABLE_HOLD_MS,
        swapSince: 1,
        containerAway: "trashed",
        goneSince: 1,
        ownerPausedAt: 1,
    });
    expect(syncHolds(all, NOW)).toEqual(["owner", "gone", "container-trashed", "swap", "unreachable", "low-disk"]);
    expect(syncHolds(pairing({ containerAway: "missing" }), NOW)).toEqual(["container-missing"]);
});

test("an outage holds it only once it has lasted an hour", () => {
    expect(syncHolds(pairing({ unreachableSince: NOW - UNREACHABLE_HOLD_MS + 1 }), NOW)).toEqual([]);
    expect(syncHolds(pairing({ unreachableSince: NOW - UNREACHABLE_HOLD_MS }), NOW)).toEqual(["unreachable"]);
});

// Only file sync is ever held: a mirror-only pairing has none, and the projects host's folders are pairings of their own.
test("nothing holds a pairing that syncs no files", () => {
    expect(syncHolds(pairing({ mode: "mirror", ownerPausedAt: 1 }), NOW)).toEqual([]);
    const host: Pairing = { sandboxUrl: "https://sandbox-0123456789ab.intentic.dev", sandboxId: "sandbox-0123456789ab-intentic-dev", mode: "sync", projectsHost: true, swapSince: 1 };
    expect(syncHolds(host, NOW)).toEqual([]);
});


/* When a pairing's file sync is held still for a swap of its sandbox on this machine, and when it is given back. */

// ic names a sandbox with a public hostname by its first label, and one without by the id its connect token derives,
// which is the id that hostname carries: a pairing's URL is that hostname, so either spelling finds its record.
test("a pairing is known to this machine's ic by its hostname's first label, or by the id in it", () => {
    expect(pairingSlugs("https://sandbox-0123456789ab.intentic.dev")).toEqual(["sandbox-0123456789ab", "0123456789ab"]);
    // The own-Cloudflare path: the owner's own subdomain is the label and the id alike.
    expect(pairingSlugs("https://work.example.com")).toEqual(["work"]);
    // A URL that does not parse names no sandbox, so nothing is ever paused on its account.
    expect(pairingSlugs("not a url")).toEqual([]);
    expect(
        recordOf(pairing(), [
            { slug: "other", phase: "cutover" },
            { slug: "0123456789ab", phase: "probation", at: NOW },
        ]),
    ).toEqual({
        slug: "0123456789ab",
        phase: "probation",
        at: NOW,
    });
    expect(recordOf(pairing(), [{ slug: "other", phase: "cutover" }])).toBeUndefined();
});

test("sync holds through the cutover and the first quarter hour of probation, then only while the sandbox is silent", () => {
    expect(holdsSync(undefined, NOW, true)).toBe(false);
    expect(holdsSync({ slug: "s" }, NOW, false)).toBe(false);
    expect(holdsSync({ slug: "s", phase: "cutover", at: NOW - 2 * PROBATION_HOLD_MS }, NOW, true)).toBe(true);
    const proving = (at: number | undefined) => ({ slug: "s", phase: "probation", at });
    expect(holdsSync(proving(NOW - PROBATION_HOLD_MS + 1), NOW, true)).toBe(true);
    expect(holdsSync(proving(NOW - PROBATION_HOLD_MS), NOW, true)).toBe(false);
    expect(holdsSync(proving(NOW - PROBATION_HOLD_MS), NOW, false)).toBe(true);
    // Nothing to measure from is read as the swap having just begun.
    expect(holdsSync(proving(undefined), NOW, true)).toBe(true);
    // A phase a newer ic adds is read as probation.
    expect(holdsSync({ slug: "s", phase: "verifying", at: NOW - 2 * PROBATION_HOLD_MS }, NOW, true)).toBe(false);
});

// The swap keeps one fact, written once as it begins and cleared once it settles; whom that holds, and whether a person's
// own pause still holds it afterwards, is `syncHolds`'s to read (above).
test("a swap's fact is written once as it begins and cleared once it settles", () => {
    expect(swapStep(pairing(), true)).toBe("began");
    expect(swapStep(pairing({ swapSince: NOW }), true)).toBeUndefined();
    expect(swapStep(pairing({ swapSince: NOW }), false)).toBe("settled");
    expect(swapStep(pairing(), false)).toBeUndefined();
});

test("forwarded ports come off localhost once the sandbox has been silent ten minutes, if it holds any", () => {
    expect(shouldReleaseForwards(RELEASE_FORWARDS_MS - 1, 2)).toBe(false);
    expect(shouldReleaseForwards(RELEASE_FORWARDS_MS, 2)).toBe(true);
    expect(shouldReleaseForwards(RELEASE_FORWARDS_MS, 0)).toBe(false);
});
