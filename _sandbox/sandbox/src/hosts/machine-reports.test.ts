import type { HostSummary, MachineFlowLine, MachineReport, MachineSandboxFlow } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { computers, manageMachineSandbox, mergeComputers, type PullResult, reportFrom, sandboxesFromTool } from "./machine-reports.js";

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

/* `run_command` answers in PROSE: it is written for the agent, which is its only other caller, so a machine
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
    // Brace-shaped but not JSON: a candidate line that will not parse must be skipped, not thrown on, this runs
    // over whatever somebody's login shell decided to print.
    expect(reportFrom(`--- stdout ---\n{ not json at all }`)).toBeUndefined();
});

// ...and a bad line must not hide a good one that follows it.
test("keeps looking past a line that only looked like JSON", () => {
    const answer = `--- stdout ---\n${JSON.stringify(report("laptop"))}\n{ tail garbage }`;
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

/* Unlike run_command, list_sandboxes answers its JSON bare: the machine's own tool produced it for this exact
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
 * same line twice. None of this comes from an agent: the card names the platform and the machine described
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

// A sync-only machine has no capability card to name its platform, so the report's own token is read: in the
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
 * the two reports agree on a hostname: the sandbox knows the machine as "laptop" (the ssh key's comment) and the
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

/* --- HOW OFTEN THE MACHINE IS ACTUALLY ASKED ---------------------------------------------------------------
 *
 * The reason this route was slow was never the merge above; it was that every reader waited on a live round trip
 * to every one of their laptops (a measured p50 of ~9.8s, with a tail past a minute). These pin the three rules
 * that fixed it, and each of them is a rule somebody could quietly undo while making the merge nicer.
 *
 * The cache lives in the module, so every test here uses ids of its own: sharing one would make the order of the
 * file part of its meaning. */

/* A history root with no enrollments file behind it, so the sync door contributes nothing and these read the
 * PULLED half alone, which is the half with the round trip in it.
 *
 * A path that does not exist rather than a real directory, and the difference is the point: nothing here writes
 * an enrollment, `readEnrollments` answers an unreadable file with an empty list, and cutting a temp tree for it
 * would put this whole file, its dozen pure-function tests included, under the integration budget for storage it
 * never touches. */
const NO_HISTORY = "/nonexistent/machine-reports-history";

interface FakeCall {
    readonly id: string;
    readonly tool: string;
    readonly signal: AbortSignal | undefined;
}

const answer = (text: string, isError = false): unknown => ({ result: { content: [{ text }], isError } });

const fakeServices = (id: string, mcp: (call: FakeCall) => Promise<unknown>): { services: Services; calls: FakeCall[] } => {
    const calls: FakeCall[] = [];
    const services = {
        config: { historyRoot: NO_HISTORY },
        perf: { track: async <T>(_op: string, _fields: unknown, run: () => Promise<T>): Promise<T> => await run() },
        capabilities: { list: async () => [{ kind: "host", id, config: { platform: "linux" } }] },
        hostHub: {
            state: () => ({ online: true, version: "0.1.0" }),
            mcp: async (asked: string, payload: unknown, options?: { signal?: AbortSignal }) => {
                const tool = (payload as { params?: { name?: string } }).params?.name ?? "";
                const call = { id: asked, tool, signal: options?.signal };
                calls.push(call);
                return await mcp(call);
            },
        },
    } as unknown as Services;
    return { services, calls };
};

afterEach(() => vi.useRealTimers());

/* THE ANSWER COMES OUT OF MEMORY AND THE REFRESH RUNS BEHIND IT. Only a machine this daemon has never once read
 * is worth waiting for; every reader after that gets the last reading at once. A reading carries its own
 * capturedAt and the view prints "Last heard from ..." over it, so serving it is not a claim that it is live. */
test("waits for the first reading of a machine, then serves it while refreshing behind the answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let hostname = "first";
    const { services, calls } = fakeServices("cached-pc", async (call) =>
        call.tool === "run_command" ? answer(JSON.stringify(report(hostname))) : answer("[]"),
    );

    // Cold: this one pays the round trip, which is the only time anybody does.
    expect((await computers(services))[0]?.report?.hostname).toBe("first");
    expect(calls).toHaveLength(2);

    // Inside the TTL: straight out of the map, machine untouched.
    hostname = "second";
    expect((await computers(services))[0]?.report?.hostname).toBe("first");
    expect(calls).toHaveLength(2);

    // Past it: the reader still gets the reading in hand rather than waiting on a new one...
    vi.setSystemTime(Date.now() + 31_000);
    expect((await computers(services))[0]?.report?.hostname).toBe("first");
    // ...and the refresh it kicked off lands for whoever asks next.
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect((await computers(services))[0]?.report?.hostname).toBe("second");
});

/* ONE OUTSTANDING PULL PER MACHINE, WHOEVER ASKS. Without this, a second browser tab, the desktop app, another
 * member of the sandbox and a poll landing on top of a manual refetch were four simultaneous round trips to one
 * laptop asking it the same question. */
test("coalesces concurrent readers into a single round trip", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { services, calls } = fakeServices("busy-pc", async (call) => {
        await held;
        return call.tool === "run_command" ? answer(JSON.stringify(report("busy"))) : answer("[]");
    });

    const readers = [computers(services), computers(services), computers(services)];
    release();
    const answers = await Promise.all(readers);

    expect(answers.every((rows) => rows[0]?.report?.hostname === "busy")).toBe(true);
    expect(calls.filter((call) => call.tool === "run_command")).toHaveLength(1);
});

/* BOTH QUESTIONS GO OUT TOGETHER. They are independent, and asking the second only once the first came back cost
 * every reporting machine two round trips where it needed one. The status call still decides what the row SAYS,
 * which is why the fleet call has to happen even on a machine whose status answer turns out to be no report at
 * all: if it did not, this test would pass with the calls back in sequence. */
test("asks for the status and the fleet in one go, and bounds the pair with one deadline", async () => {
    const { services, calls } = fakeServices("bare-pc", async (call) =>
        call.tool === "run_command" ? answer("intentic-sync: command not found", false) : answer("[]"),
    );

    expect((await computers(services))[0]?.gap).toBe("no-agent");
    expect(calls.map((call) => call.tool).toSorted()).toEqual(["list_sandboxes", "run_command"]);
    // One signal over the whole reading, and it is the daemon's own: without it the only ceiling on this route is
    // the hub's fifteen-minute backstop, which is what the minute-long samples in the perf log were.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
});

// A machine that will not answer is a machine you cannot read: the row says so instead of the request hanging on
// it. Same outcome the deadline produces, reached here without waiting for one.
test("a machine that refuses to answer at all reads as offline", async () => {
    const { services } = fakeServices("dead-pc", () => Promise.reject(new Error("socket is gone")));
    expect((await computers(services))[0]).toMatchObject({ hostId: "dead-pc", gap: "offline" });
});

/* ---- runner lifecycle, the two ops the daemon fills in for ---- */

// The flow the machine was actually asked to run, plus the store the parent kept: enough to see both halves of
// starting a runner, the pairing this side mints and the argv the far side gets.
const runnerServices = (
    overrides: { publicUrl?: string; online?: boolean } = {},
): { services: Services; sent: MachineSandboxFlow[]; minted: string[]; revoked: string[]; disconnected: string[] } => {
    const sent: MachineSandboxFlow[] = [];
    const minted: string[] = [];
    const revoked: string[] = [];
    const disconnected: string[] = [];
    const services = {
        config: { historyRoot: NO_HISTORY, sandbox: { publicUrl: overrides.publicUrl ?? "https://sandbox-x.intentic.dev" } },
        runners: {
            mintPairing: (id: string) => {
                minted.push(id);
                return { token: `pair-for-${id}`, expiresIn: 600 };
            },
            revoke: async (id: string) => {
                revoked.push(id);
                return true;
            },
        },
        runnerHub: { disconnect: (id: string) => disconnected.push(id) },
        hostHub: {
            client:
                overrides.online === false
                    ? () => undefined
                    : () => ({
                          runSandboxFlow: async (flow: MachineSandboxFlow) => {
                              sent.push(flow);
                              return (async function* () {
                                  yield { kind: "line", text: "working" } as const;
                                  yield { kind: "result", message: "done" } as const;
                              })();
                          },
                      }),
        },
    } as unknown as Services;
    return { services, sent, minted, revoked, disconnected };
};

const drain = async (flow: AsyncGenerator<MachineFlowLine>): Promise<MachineFlowLine[]> => {
    const lines: MachineFlowLine[] = [];
    for await (const line of flow) {
        lines.push(line);
    }
    return lines;
};

/* THE PAIRING IS THE DAEMON'S TO MINT, never the caller's to carry. A browser that could name the credential
 * could mint a runner anywhere; what it names is a machine and a name, and this side supplies the rest. */
test("starting a runner fills in this sandbox's address and a pairing bound to the runner's own name", async () => {
    const { services, sent, minted } = runnerServices();
    await drain(manageMachineSandbox(services, "rog", { op: "runner-up", slug: "rig" }));
    expect(minted).toEqual(["rig"]);
    expect(sent[0]).toEqual({ op: "runner-up", slug: "rig", parentUrl: "https://sandbox-x.intentic.dev", pair: "pair-for-rig" });
});

test("a sandbox with no public address refuses rather than leaving a container with no way home", async () => {
    const { services, sent, minted } = runnerServices({ publicUrl: "" });
    await expect(drain(manageMachineSandbox(services, "rog", { op: "runner-up", slug: "rig" }))).rejects.toThrow(/public address/i);
    expect(minted).toEqual([]);
    expect(sent).toEqual([]);
});

// Every other op is passed through untouched: the injection is for `runner-up` alone, and a pairing riding an
// update would be a live credential in a flow that has no use for one.
test("no other op grows a pairing", async () => {
    const { services, sent, minted } = runnerServices();
    await drain(manageMachineSandbox(services, "rog", { op: "update", slug: "work" }));
    expect(sent[0]).toEqual({ op: "update", slug: "work" });
    expect(minted).toEqual([]);
});

/* A RUNNER REMOVED FROM ITS MACHINE IS REMOVED HERE TOO, and only on the machine's own success: a removal that
 * failed left the container running, and revoking its way home would strand a working runner. */
test("a removed runner loses its enrollment here, but only when the machine says it worked", async () => {
    const { services, revoked, disconnected } = runnerServices();
    await drain(manageMachineSandbox(services, "rog", { op: "runner-remove", slug: "rig" }));
    expect(revoked).toEqual(["rig"]);
    expect(disconnected).toEqual(["rig"]);
});
