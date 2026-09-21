import type { PortSummary } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import type { Pairing, SyncState } from "./config.js";
import { skippedPortsOf } from "./mirror.js";
import { buildReport, scopedReport } from "./report.js";

// The resting state: build and installed match, so nothing here quietly tests a device behind itself.
const AGENT = { running: true, pid: 4242, build: "1.2.0", installed: "1.2.0" };

const pairing = (overrides: Partial<Pairing> & Pick<Pairing, "sandboxId">): Pairing => ({
    sandboxUrl: `https://${overrides.sandboxId}.example.dev`,
    mode: "sync",
    ...overrides,
});

// No Mutagen passed here: everything asserted (folder, ports, who's withheld) is decided before Mutagen would be
// consulted.
const report = (state: SyncState) => buildReport(state, undefined, AGENT, 1_700_000_000_000);

describe("buildReport", () => {
    it("names the folder each paired sandbox syncs into", () => {
        const built = report({ pairings: [pairing({ sandboxId: "work", localDir: "/home/me/intentic/work" })] });
        // `mirroring: "on"` is stated even untouched, since an absent port list would otherwise mean both "off" and
        // "nothing listening".
        expect(built.pairings).toEqual([{ sandboxId: "work", mode: "sync", localDir: "/home/me/intentic/work", mirroring: "on" }]);
    });

    // Off, this device reports no ports for that sandbox, identical to a sandbox serving nothing; the mirroring state
    // itself is what tells the two apart.
    it("says when this device has been told to keep its localhost clear", () => {
        const built = report({ pairings: [pairing({ sandboxId: "work", localDir: "/home/me/intentic/work", mirrorOff: true })] });
        expect(built.pairings.map((entry) => entry.mirroring)).toEqual(["off"]);
        // File syncing is untouched by the switch; that's why this isn't just unpairing the sandbox.
        expect(built.pairings.map((entry) => entry.localDir)).toEqual(["/home/me/intentic/work"]);
    });

    // The skip set: a port that never reached localhost stays in the report saying why, not silently absent.
    it("reports the ports that lost as well as the ones that won", () => {
        const built = report({
            pairings: [
                pairing({
                    sandboxId: "work",
                    mirroredPorts: [{ port: 5173, host: "127.0.0.1", command: "node vite" }],
                    skippedPorts: [
                        { port: 6480, host: "127.0.0.1", reason: "held-by-sandbox", heldBy: "scratch", command: "node next" },
                        { port: 8080, host: "::1", reason: "busy" },
                        { port: 5440, host: "127.0.0.1", reason: "ignored", command: "postgres" },
                    ],
                }),
            ],
        });
        expect(built.ports).toEqual([
            { port: 5173, host: "127.0.0.1", sandboxId: "work", state: "mirrored", command: "node vite" },
            { port: 6480, host: "127.0.0.1", sandboxId: "work", state: "held-by-sandbox", heldBy: "scratch", command: "node next" },
            // No heldBy ⇒ something on the machine that is not one of our sandboxes has the port.
            { port: 8080, host: "::1", sandboxId: "work", state: "busy", heldBy: undefined, command: undefined },
            // Somebody's own choice, carried as its own state: a reader must never be shown this as a contest lost.
            { port: 5440, host: "127.0.0.1", sandboxId: "work", state: "ignored", heldBy: undefined, command: "postgres" },
        ]);
    });

    // The docker half is never this agent's to report: enumerating a machine's containers is a disclosure this
    // design rules out, so a report carries no such field at all — asked for by name through the host door instead.
    // Asserted on the keys, since a value this side never sets can only come back as a field somebody added.
    it("never reports containers", () => {
        expect(Object.keys(report({ pairings: [pairing({ sandboxId: "work" })] }))).not.toContain("sandboxes");
    });

    it("carries the agent, because everything else is only true while its agent runs", () => {
        expect(report({ pairings: [] }).agent).toEqual(AGENT);
        expect(buildReport({ pairings: [] }, undefined, { running: false }, 1).agent).toEqual({ running: false });
    });

    // Installed and running are two separate facts: a device updated but not restarted has different `build` and
    // `installed`, invisible if collapsed to one number.
    it("reports the installed agent and the running agent as separate builds of one block", () => {
        const built = buildReport({ pairings: [] }, undefined, { running: true, pid: 4242, build: "1.1.0", installed: "1.2.0" }, 1);
        expect(built.agent.installed).toBe("1.2.0");
        expect(built.agent.build).toBe("1.1.0");
    });

    // A device with no installed agent to ask (dev run, npx) leaves it unstated, rather than borrowing the reporting
    // process's own version.
    it("leaves the installed agent unstated when there is none to read", () => {
        expect(buildReport({ pairings: [] }, undefined, { running: true, pid: 4242, build: "1.2.0" }, 1).agent.installed).toBeUndefined();
    });
});

describe("scopedReport", () => {
    const machine: SyncState = {
        pairings: [
            pairing({ sandboxId: "mine", localDir: "/home/me/intentic/mine", mirroredPorts: [{ port: 5173, host: "127.0.0.1" }] }),
            pairing({ sandboxId: "theirs", mode: "mirror", mirroredPorts: [{ port: 6480, host: "127.0.0.1" }] }),
        ],
    };

    // A sandbox is told about its own pairing and nothing else; the rule that lets a report cross the network.
    it("gives a sandbox its own pairing and none of its siblings'", () => {
        const scoped = scopedReport(report(machine), "mine");
        expect(scoped.pairings.map((entry) => entry.sandboxId)).toEqual(["mine"]);
        expect(scoped.ports.map((port) => port.port)).toEqual([5173]);
    });

    // A collaborator mirroring one port must not hand the sandbox owner a map of their machine; a "mirror" pairing
    // has no localDir at all, so scoping is the withholding.
    it("carries no local folder to a sandbox that only mirrors ports", () => {
        const scoped = scopedReport(report(machine), "theirs");
        expect(scoped.pairings).toEqual([{ sandboxId: "theirs", mode: "mirror", localDir: undefined, mirroring: "on" }]);
        expect(scoped.ports.map((port) => port.sandboxId)).toEqual(["theirs"]);
    });
});

// The skip set is derived from what reconcile already decided: every desired port not mirrored is a skip, and
// claimedBy separates a sibling sandbox's win from something else holding it.
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

    const nothingIgnored = new Set<number>();

    it("is empty when every wanted port was mirrored", () => {
        expect(skippedPortsOf([summary(5173)], [{ port: 5173, host: "127.0.0.1" }], new Map(), nothingIgnored)).toEqual([]);
    });

    it("names the sandbox that took the port, and leaves it unnamed when a foreign process did", () => {
        const skipped = skippedPortsOf([summary(6480, "node next"), summary(8080)], [], new Map([[6480, "scratch"]]), nothingIgnored);
        expect(skipped).toEqual([
            { port: 6480, host: "127.0.0.1", reason: "held-by-sandbox", heldBy: "scratch", command: "node next" },
            { port: 8080, host: "127.0.0.1", reason: "busy", heldBy: undefined, command: undefined },
        ]);
    });

    // A set-aside port stays in the list — it is the only row the switch can be thrown back from — and carries the
    // reason nobody tried, rather than the reason nobody measured.
    it("files a port this device was told to leave alone as ignored, not as busy", () => {
        const skipped = skippedPortsOf([summary(5440, "postgres")], [], new Map(), new Set([5440]));
        expect(skipped).toEqual([{ port: 5440, host: "127.0.0.1", reason: "ignored", heldBy: undefined, command: "postgres" }]);
    });

    // Reconcile never entered the contest, so naming a winner here would be inventing a fact about a pass that
    // never happened — and would hand the row a "show it" link to a sandbox that took nothing from it.
    it("calls an ignored port ignored even when another sandbox holds the number", () => {
        const skipped = skippedPortsOf([summary(5440)], [], new Map([[5440, "scratch"]]), new Set([5440]));
        expect(skipped).toEqual([{ port: 5440, host: "127.0.0.1", reason: "ignored", heldBy: undefined, command: undefined }]);
    });
});
