import type { PortSummary } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import type { Pairing, SyncState } from "./config.js";
import { skippedPortsOf } from "./mirror.js";
import { buildReport, scopedReport } from "./report.js";

const WATCHER = { running: true, pid: 4242 };

const pairing = (overrides: Partial<Pairing> & Pick<Pairing, "sandboxId">): Pairing => ({
    sandboxUrl: `https://${overrides.sandboxId}.example.dev`,
    mode: "sync",
    ...overrides,
});

// No Mutagen passed anywhere here: the session reads spawn a binary, and everything these assert about, which
// folder, which ports, who is withheld from whom: is decided before one is consulted.
const report = (state: SyncState) => buildReport(state, undefined, WATCHER, 1_700_000_000_000);

describe("buildReport", () => {
    it("names the folder each paired sandbox syncs into", () => {
        const built = report({ pairings: [pairing({ sandboxId: "work", localDir: "/home/me/intentic/work" })] });
        // `mirroring: "on"` on a pairing nobody has touched: the flag is stated on every one of them rather than
        // left to be inferred, because an absent port list means "off" and "nothing is listening" alike.
        expect(built.pairings).toEqual([{ sandboxId: "work", mode: "sync", localDir: "/home/me/intentic/work", mirroring: "on" }]);
    });

    /* THE SWITCH, AS THE SANDBOX SEES IT. Off, this computer stops putting that sandbox's ports on its own
     * localhost and reports none, which is byte-for-byte what a sandbox serving nothing looks like. So the state
     * itself is carried: it is the only thing that tells the two apart, and the only thing a Stop-mirroring
     * button can point off. */
    it("says when this computer has been told to keep its localhost clear", () => {
        const built = report({ pairings: [pairing({ sandboxId: "work", localDir: "/home/me/intentic/work", mirrorOff: true })] });
        expect(built.pairings.map((entry) => entry.mirroring)).toEqual(["off"]);
        // File syncing is untouched by it, which is the whole reason this is not just "unpair the sandbox".
        expect(built.pairings.map((entry) => entry.localDir)).toEqual(["/home/me/intentic/work"]);
    });

    // The whole point of the skip set: a port the sandbox serves that never reached localhost is IN the report,
    // saying why, rather than being silently absent the way it is on a terminal nobody has open.
    it("reports the ports that lost as well as the ones that won", () => {
        const built = report({
            pairings: [
                pairing({
                    sandboxId: "work",
                    mirroredPorts: [{ port: 5173, host: "127.0.0.1", command: "node vite" }],
                    skippedPorts: [
                        { port: 6480, host: "127.0.0.1", heldBy: "scratch", command: "node next" },
                        { port: 8080, host: "::1" },
                    ],
                }),
            ],
        });
        expect(built.ports).toEqual([
            { port: 5173, host: "127.0.0.1", sandboxId: "work", state: "mirrored", command: "node vite" },
            { port: 6480, host: "127.0.0.1", sandboxId: "work", state: "held-by-sandbox", heldBy: "scratch", command: "node next" },
            // No heldBy ⇒ something on the machine that is not one of our sandboxes has the port.
            { port: 8080, host: "::1", sandboxId: "work", state: "busy", heldBy: undefined, command: undefined },
        ]);
    });

    /* The docker half is never the agent's to report: a sync agent enumerating a machine's containers is the
     * disclosure this design rules out by construction. Readers fill it; asserted here so nothing quietly starts. */
    it("never reports containers", () => {
        expect(report({ pairings: [pairing({ sandboxId: "work" })] }).sandboxes).toEqual([]);
    });

    it("carries the watcher, because everything else is only true while it runs", () => {
        expect(report({ pairings: [] }).watcher).toEqual(WATCHER);
        expect(buildReport({ pairings: [] }, undefined, { running: false }, 1).watcher).toEqual({ running: false });
    });
});

describe("scopedReport", () => {
    const machine: SyncState = {
        pairings: [
            pairing({ sandboxId: "mine", localDir: "/home/me/intentic/mine", mirroredPorts: [{ port: 5173, host: "127.0.0.1" }] }),
            pairing({ sandboxId: "theirs", mode: "mirror", mirroredPorts: [{ port: 6480, host: "127.0.0.1" }] }),
        ],
    };

    // A sandbox is told about its own pairing and nothing else: the one rule that lets a report cross the
    // network at all.
    it("gives a sandbox its own pairing and none of its siblings'", () => {
        const scoped = scopedReport(report(machine), "mine");
        expect(scoped.pairings.map((entry) => entry.sandboxId)).toEqual(["mine"]);
        expect(scoped.ports.map((port) => port.port)).toEqual([5173]);
    });

    /* A collaborator mirroring one dev-server port must not hand the sandbox's owner a map of their machine. A
     * "mirror" pairing has no localDir to begin with, so scoping IS the withholding: asserted because the day
     * that stops being true, this is the test that says so. */
    it("carries no local folder to a sandbox that only mirrors ports", () => {
        const scoped = scopedReport(report(machine), "theirs");
        expect(scoped.pairings).toEqual([{ sandboxId: "theirs", mode: "mirror", localDir: undefined, mirroring: "on" }]);
        expect(scoped.ports.map((port) => port.sandboxId)).toEqual(["theirs"]);
    });
});

/* The skip set is DERIVED from what the reconcile already decided rather than reported out of it, so these pin
 * the derivation: every desired port that did not end up mirrored is a skip, and claimedBy is what separates
 * "a sibling sandbox won it" from "something else on this machine holds it". */
describe("skippedPortsOf", () => {
    const summary = (port: number, command?: string): PortSummary => ({
        port,
        host: "127.0.0.1",
        forwardable: true,
        kind: "workspace",
        title: "Vite dev server",
        purpose: "Started in one of your terminals.",
        origin: "terminal",
        forwarded: false,
        command,
    });

    it("is empty when every wanted port was mirrored", () => {
        expect(skippedPortsOf([summary(5173)], [{ port: 5173, host: "127.0.0.1" }], new Map())).toEqual([]);
    });

    it("names the sandbox that took the port, and leaves it unnamed when a foreign process did", () => {
        const skipped = skippedPortsOf([summary(6480, "node next"), summary(8080)], [], new Map([[6480, "scratch"]]));
        expect(skipped).toEqual([
            { port: 6480, host: "127.0.0.1", heldBy: "scratch", command: "node next" },
            { port: 8080, host: "127.0.0.1", heldBy: undefined, command: undefined },
        ]);
    });
});
