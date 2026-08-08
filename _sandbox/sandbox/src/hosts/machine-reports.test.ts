import type { HostSummary, MachineReport } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { mergeComputers, type PullResult, reportFrom, sandboxesFromTool } from "./machine-reports.js";

const report = (hostname: string, overrides: Partial<MachineReport> = {}): MachineReport => ({
    hostname,
    os: "linux",
    agents: { sync: "0.1.0" },
    sandboxes: [],
    pairings: [],
    ports: [],
    watcher: { running: true },
    capturedAt: 1_700_000_000_000,
    ...overrides,
});

// A host capability as the hub holds it: the card's platform always, and what the machine said about itself only
// once it has connected.
const host = (id: string, overrides: Partial<HostSummary> = {}): HostSummary => ({
    id,
    platform: "linux",
    online: true,
    ...overrides,
});

/* `run_command` answers in PROSE — it is written for the agent, which is its only other caller — so a machine
 * reader has to find its JSON inside a human answer. These pin that extraction, because it is the one place this
 * feature depends on the shape of somebody else's output. */
test("finds the report inside run_command's prose answer", () => {
    const answer = `Exit code 0 (success).\n--- stdout ---\n${JSON.stringify(report("laptop"))}`;
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

test("survives a banner before it and a warning after it", () => {
    const answer = [
        "Exit code 0 (success).",
        "--- stdout ---",
        "Welcome to your shell!",
        JSON.stringify(report("laptop")),
        "--- stderr ---",
        "warning: something unrelated",
    ].join("\n");
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

// "There is no report here" has to be distinguishable from a report, or a machine with no agent reads as a
// machine with no folders and no ports.
test("finds nothing when the command printed no report", () => {
    expect(reportFrom("Exit code 127 (failed).\n--- stderr ---\nintentic-sync: command not found")).toBeUndefined();
    // JSON that is not a report is not a report.
    expect(reportFrom(`--- stdout ---\n{"hostname":"laptop"}`)).toBeUndefined();
    // Brace-shaped but not JSON: a candidate line that will not parse must be skipped, not thrown on — this runs
    // over whatever somebody's login shell decided to print.
    expect(reportFrom(`--- stdout ---\n{ not json at all }`)).toBeUndefined();
});

// ...and a bad line must not hide a good one that follows it.
test("keeps looking past a line that only looked like JSON", () => {
    const answer = `--- stdout ---\n${JSON.stringify(report("laptop"))}\n{ tail garbage }`;
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

/* Unlike run_command, list_sandboxes answers its JSON bare — the machine's own tool produced it for this exact
 * reader. What still needs pinning is the skew: a machine running an agent from before the tool refuses it, and
 * that must read as a machine with no listable sandboxes, never as a failed pull. */
test("reads the fleet the machine's own tool answered", () => {
    const fleet = [{ slug: "work", container: "intentic-sandbox-work", running: true, image: "img" }];
    expect(sandboxesFromTool(JSON.stringify(fleet, undefined, 2), false)).toEqual(fleet);
});

test("an agent without the tool, or an answer that is not the fleet, contributes no sandboxes", () => {
    expect(sandboxesFromTool(`This computer has no tool called "list_sandboxes".`, true)).toEqual([]);
    expect(sandboxesFromTool("not json", false)).toEqual([]);
    expect(sandboxesFromTool(`{"slug":"work"}`, false)).toEqual([]);
});

test("keeps an enrolled machine that has never reported, and says why it is empty", () => {
    const merged = mergeComputers(["laptop"], [], []);
    expect(merged).toEqual([{ key: "laptop", label: "laptop", syncEnrolled: true, gap: "unreported" }]);
});

/* WHAT THE MACHINE IS has to survive having no report, because that is the row it matters on: a connected
 * computer with no sync agent had nothing on it but a name, so a Windows PC and a Linux desktop rendered as the
 * same line twice. None of this comes from an agent — the card names the platform and the machine described
 * itself when it connected. */
test("says what a connected computer is even when it reported nothing", () => {
    const facts = { os: "Windows 11 Pro (build 10.0.26100)", arch: "x64", shell: "PowerShell 7", home: "C:\\Users\\ada", roots: ["C:\\Users\\ada"] };
    const merged = mergeComputers(
        [],
        [],
        [{ host: host("my-pc", { platform: "windows", facts, version: "0.5.1", lastSeen: 1_700_000_000_000 }), result: { gap: "no-agent" } }],
    );
    expect(merged[0]).toEqual({
        key: "my-pc",
        label: "my-pc",
        syncEnrolled: false,
        hostId: "my-pc",
        online: true,
        platform: "windows",
        facts,
        hostAgent: "0.5.1",
        lastSeen: 1_700_000_000_000,
        gap: "no-agent",
    });
});

// A sync-only machine has no capability card to name its platform, so the report's own token is read — in the
// spelling `os.platform()` uses, which is not one anybody should have to recognise on screen.
test("reads a sync-only machine's platform off its report", () => {
    const merged = mergeComputers(
        ["laptop", "mac"],
        [
            { machine: "laptop", report: report("laptop-box", { os: "win32" }) },
            { machine: "mac", report: report("mac-box", { os: "darwin" }) },
        ],
        [],
    );
    expect(merged.map((row) => row.platform)).toEqual(["windows", "macos"]);
});

/* The conservative half of the reconciliation. Both doors onto the SAME box collapse into one row only because
 * the two reports agree on a hostname — the sandbox knows the machine as "laptop" (the ssh key's comment) and the
 * capability calls it "my-pc", and neither name could have told us they were the same computer. */
test("folds a sync enrollment and a host capability into one row when the hostname agrees", () => {
    const pulled: PullResult = {
        report: report("blackbox", { sandboxes: [{ slug: "work", container: "intentic-sandbox-work", running: true, image: "img" }] }),
    };
    const merged = mergeComputers(["laptop"], [{ machine: "laptop", report: report("blackbox") }], [{ host: host("my-pc"), result: pulled }]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: "blackbox", label: "laptop", syncEnrolled: true, hostId: "my-pc", online: true });
    // The pulled report wins, because it is the only one carrying containers.
    expect(merged[0]?.report?.sandboxes).toHaveLength(1);
});

// The failure this conservatism exists to prevent: two collaborators' laptops on one shared sandbox must never
// become one row just because both are reachable.
test("keeps two machines apart when nothing says they are the same box", () => {
    const merged = mergeComputers(
        ["ada-laptop"],
        [{ machine: "ada-laptop", report: report("ada-box") }],
        [{ host: host("grace-pc"), result: { report: report("grace-box") } }],
    );
    expect(merged.map((row) => row.key)).toEqual(["ada-box", "grace-box"]);
    expect(merged.map((row) => row.syncEnrolled)).toEqual([true, false]);
});

/* Each gap is a different errand, so each survives to the UI as itself. "scope-off" in particular is the one the
 * reader can close in a single click, and the tab can only say which switch if the daemon does not flatten it. */
test("carries the reason a reachable computer produced nothing", () => {
    const merged = mergeComputers(
        [],
        [],
        [
            { host: host("asleep", { online: false }), result: { gap: "offline" } },
            { host: host("locked-down"), result: { gap: "scope-off" } },
            { host: host("bare"), result: { gap: "no-agent" } },
        ],
    );
    expect(merged.map((row) => row.gap)).toEqual(["offline", "scope-off", "no-agent"]);
    expect(merged.every((row) => !row.syncEnrolled)).toBe(true);
});
