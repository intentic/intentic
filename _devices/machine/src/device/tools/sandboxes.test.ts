import type { DeviceScopes } from "@intentic/sandbox-contract";
import { ScopeError } from "../policy.js";
import {
    createSandbox,
    fleetFrom,
    forgetShape,
    icConnectArgs,
    icConnectEnv,
    icRemoveArgs,
    icRunnerArgs,
    icSwapArgs,
    lineSplitter,
    olderResizePlan,
    listSandboxes,
    manageSandbox,
    reconnectSandbox,
    removeSandbox,
    reshapeSandbox,
    runnerFlow,
    sandboxLogs,
    shapeSandbox,
    swapSandbox,
    tailSandboxLogs,
} from "./sandboxes.js";
import { featuresFrom, fetchIc, icCandidates, icNeedsFetch, icVersionFrom } from "./ic-binary.js";

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

// What ic prints for `ic sandbox list --json`, verbatim from its listing (listing.rs's own test builds the same object):
// the agent parses it against the contract rather than re-deriving any of it from docker.
const listed = {
    slug: "work",
    container: "intentic-sandbox-work",
    running: true,
    image: "ghcr.io/intentic/sandbox:stable",
    tunnelRunning: false,
    resources: {
        memoryBytes: 12 * 1024 ** 3,
        cpus: 4,
        privileged: false,
        gpu: true,
        hostRuntime: ["--gpus=all"],
        overlayRuntime: ["--device=/dev/net/tun"],
        shape: { memoryGib: 12, cpus: null, privileged: false, gpu: true },
        desired: { memoryGib: 20, cpus: null, privileged: false, gpu: true },
    },
    staged: { image: "img:next", version: "1.4.2" },
};

test("the fleet is ic's own listing, read as the contract's rows with nothing added or merged", () => {
    expect(fleetFrom(`${JSON.stringify([listed])}\n`)).toEqual([listed]);
    // A note ic wrote to the same stream (a CRLF console, a warning) does not hide the listing.
    expect(fleetFrom(`note: something\r\n${JSON.stringify([listed])}\r\n`)).toEqual([listed]);
    expect(fleetFrom("[]")).toEqual([]);
});

// An ic from before `--json` prints a usage error or the text listing; either way it is not a fleet of nothing.
test("an ic that does not answer the listing is named, never read as a machine with no sandboxes", () => {
    expect(() => fleetFrom("running   work\n")).toThrow(/did not answer `ic sandbox list --json`/);
    expect(() => fleetFrom(JSON.stringify([{ slug: "work" }]))).toThrow(/update ic/);
});

test("listing is refused only when NEITHER grant covers it, naming the manage switch", async () => {
    await expect(listSandboxes(scopes({ shell: "off", sandboxes: "off" }))).rejects.toThrow(ScopeError);
    await expect(listSandboxes(scopes({ shell: "off", sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this device/);
});

test("managing is refused by the sandboxes switch alone: a full shell does not imply it", async () => {
    await expect(manageSandbox("stop", "work", scopes({ sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this device/);
});

// ---- the flows that run `ic` ----

// The argv, both platforms' worth of risk in one place: an argument that regresses to a different position
// binds to a different parameter and fails silently, much later, as something else.
test("each swap builds the argv ic actually takes", () => {
    expect(icSwapArgs("update", "work", undefined)).toEqual(["sandbox", "update", "work"]);
    expect(icSwapArgs("rollback", "work", undefined)).toEqual(["sandbox", "rollback", "work"]);
    expect(icSwapArgs("rebuild", "work", "deadbeef")).toEqual(["sandbox", "rebuild", "work", "deadbeef"]);
    // `prepare` is the one that must never reach `update`: it exists precisely because it does not restart the
    // sandbox, and a verb that slipped would recreate a container someone was told nothing about.
    expect(icSwapArgs("prepare", "work", undefined)).toEqual(["sandbox", "prepare", "work"]);
    // A hash tagging along changes nothing: prepare re-applies whatever the owner has approved, and taking a
    // digest here would silently turn it into a rebuild.
    expect(icSwapArgs("prepare", "work", "deadbeef")).toEqual(["sandbox", "prepare", "work"]);
});

// ic sandbox connect derives the sandbox from the claim; a slug alongside it would pick a second one.
test("a reconnect redeems the claim and lets ic derive the sandbox from it", () => {
    expect(icConnectArgs("code-abc")).toEqual(["sandbox", "connect", "-y", "--", "code-abc"]);
    expect(icConnectArgs("  code-abc  ")).toEqual(["sandbox", "connect", "-y", "--", "code-abc"]);
});

// A code starting with a hyphen is a code, not a flag: `--` is what keeps the argument parser from reading it as one.
test("a reconnect passes a hyphen-leading code as a value", () => {
    expect(icConnectArgs("-Tq9xk")).toEqual(["sandbox", "connect", "-y", "--", "-Tq9xk"]);
});

test("a reconnect with no claim is refused rather than run as a bare connect", () => {
    // Without a code, ic sandbox connect -y opens an interactive wizard this machine has no terminal for.
    expect(() => icConnectArgs(undefined)).toThrow(/setupCode.*required/i);
    expect(() => icConnectArgs("")).toThrow(/required/i);
    expect(() => icConnectArgs("   ")).toThrow(/required/i);
});

// The claim is single-use: a create that would land on a name already taken has to refuse BEFORE ic runs, or the
// owner pays a round trip to the platform for a code that bought nothing.
test("a create with no claim is refused before the fleet is even read", async () => {
    await expect(createSandbox("reviewer", undefined, "https://api.intentic.dev", scopes(), () => {})).rejects.toThrow(/setupCode.*required/i);
});

// Left to its default, ic redeems at production, which answers a dev platform's code with "invalid or expired".
test("a create or reconnect that does not name the minting platform is refused before the fleet is even read", async () => {
    await expect(createSandbox("reviewer", "code-abc", undefined, scopes(), () => {})).rejects.toThrow(/platformUrl.*required/i);
    await expect(reconnectSandbox("work", "code-abc", undefined, scopes(), () => {})).rejects.toThrow(/platformUrl.*required/i);
    await expect(createSandbox("reviewer", "code-abc", "  ", scopes(), () => {})).rejects.toThrow(/platformUrl.*required/i);
});

test("creating is refused by the sandboxes switch, like every other verb that runs ic", async () => {
    await expect(createSandbox("reviewer", "code-abc", "https://api.intentic.dev", scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(
        /Manage sandboxes on this device/,
    );
});

test("ic redeems the claim at the platform that minted it", () => {
    expect(icConnectEnv("https://api.intentic.dev")).toEqual({ PLATFORM_URL: "https://api.intentic.dev" });
    expect(icConnectEnv("https://api.intentic.dev/")).toEqual({ PLATFORM_URL: "https://api.intentic.dev" });
});

// The daemon's own spelling of a dev platform on this machine resolves nowhere outside a container.
test("a platform the daemon reaches as host.docker.internal is redeemed at this machine's localhost, port kept", () => {
    expect(icConnectEnv("https://host.docker.internal:6480")).toEqual({ PLATFORM_URL: "https://localhost:6480" });
});

test("a rebuild without the approved digest is refused rather than built against nothing", () => {
    // The hash is the trust anchor: only content that still hashes to what the owner reviewed is ever built, so a
    // missing one has to stop the flow rather than fall through to an unpinned rebuild.
    expect(() => icSwapArgs("rebuild", "work", undefined)).toThrow(/hash.*required/i);
    expect(() => icSwapArgs("rebuild", "work", "")).toThrow(/approved/);
});

// The old op is carried out by the same `ic sandbox shape` argv as `set-shape`: its delta is a shape, `later` is the next
// restart, an empty `later` forgets, and an empty ask now is the restart that applies what is saved.
test("the old reshape op maps onto the shape verb, the forget, or the restart that applies what is saved", () => {
    expect(olderResizePlan({ memoryGib: 12, cpus: null }, false)).toEqual({ kind: "shape", fields: { memoryGib: 12, cpus: null }, when: "now" });
    expect(olderResizePlan({ gpu: true }, true)).toEqual({ kind: "shape", fields: { gpu: true }, when: "nextRestart" });
    expect(olderResizePlan(undefined, true)).toEqual({ kind: "forget" });
    expect(olderResizePlan({}, true)).toEqual({ kind: "forget" });
    expect(olderResizePlan(undefined, false)).toEqual({ kind: "apply-saved" });
});

test("a shape that sets nothing is refused before ic is asked, so it can never restart anything", async () => {
    await expect(shapeSandbox("work", {}, "now", scopes(), () => {})).rejects.toThrow(/has to set something/);
    await expect(shapeSandbox("work", { memoryGib: undefined }, "nextRestart", scopes(), () => {})).rejects.toThrow(/has to set something/);
});

test("setting and forgetting a shape are refused by the sandboxes switch, like every verb that runs ic", async () => {
    await expect(shapeSandbox("work", { cpus: 4 }, "nextRestart", scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(
        /Manage sandboxes on this device/,
    );
    await expect(forgetShape("work", scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(/Manage sandboxes on this device/);
});

test("reshaping is refused by the sandboxes switch, like the swaps it shares a door with", async () => {
    await expect(reshapeSandbox("work", { memoryGib: 12 }, scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(
        /Manage sandboxes on this device/,
    );
});

test("removal confirms itself, because there is no terminal on this end to answer ic's prompt", () => {
    expect(icRemoveArgs("work")).toEqual(["sandbox", "remove", "work", "-y"]);
});

// The runner argv, which carries something no other flow does: a single-use pairing. An argument lost here is
// invisible in the worst way: the container boots, dials, is refused, and reads as a network problem.
test("a runner is started with its parent's address and its pairing, and removed without a prompt", () => {
    expect(icRunnerArgs("runner-up", "rig", "https://sandbox-x.intentic.dev", "pair-1")).toEqual([
        "runner",
        "up",
        "https://sandbox-x.intentic.dev",
        "--pair",
        "pair-1",
        "--name",
        "rig",
    ]);
    expect(icRunnerArgs("runner-remove", "rig", undefined, undefined)).toEqual(["runner", "remove", "rig", "-y"]);
});

test("a runner start with no way home is refused before anything is spawned", () => {
    // A container with no parent URL, or none of the pairing that gets it enrolled, is a container somebody has to
    // clean up by hand: it can never become a runner, and it says nothing about why.
    expect(() => icRunnerArgs("runner-up", "rig", "", "pair-1")).toThrow(/address/i);
    expect(() => icRunnerArgs("runner-up", "rig", "https://sandbox-x.intentic.dev", "")).toThrow(/pairing/i);
});

test("both runner ops ride the sandboxes switch", async () => {
    const off = scopes({ sandboxes: "off" });
    await expect(runnerFlow("runner-up", "rig", "https://x", "p", {}, off, () => undefined)).rejects.toBeInstanceOf(ScopeError);
    await expect(runnerFlow("runner-remove", "rig", undefined, undefined, {}, off, () => undefined)).rejects.toBeInstanceOf(ScopeError);
});

// The parent's shape files, appended only when they exist. The hash is the trust anchor: an overlay riding
// without one would ask this machine to build content nobody's approval pins.
test("shape files ride the runner-up argv, and an overlay without its hash is refused", () => {
    expect(icRunnerArgs("runner-up", "rig", "https://x", "p", { definitionFile: "/tmp/d/sandbox.toml" })).toEqual([
        "runner",
        "up",
        "https://x",
        "--pair",
        "p",
        "--name",
        "rig",
        "--definition-file",
        "/tmp/d/sandbox.toml",
    ]);
    expect(icRunnerArgs("runner-up", "rig", "https://x", "p", { overlayFile: "/tmp/d/overlay.Dockerfile", environmentHash: "a".repeat(64) })).toEqual(
        [
            "runner",
            "up",
            "https://x",
            "--pair",
            "p",
            "--name",
            "rig",
            "--overlay-file",
            "/tmp/d/overlay.Dockerfile",
            "--environment-hash",
            "a".repeat(64),
        ],
    );
    expect(() => icRunnerArgs("runner-up", "rig", "https://x", "p", { overlayFile: "/tmp/d/overlay.Dockerfile" })).toThrow(/hash/);
    expect(() => icRunnerArgs("runner-up", "rig", "https://x", "p", { environmentHash: "a".repeat(64) })).toThrow(/overlay/);
});

// The agent's own install is preferred over PATH, per platform: a developer's global copy answers on the
// machine where this was written and nothing answers on a real user's.
test("ic is looked for where the installers put it before PATH is tried", () => {
    expect(icCandidates("linux", "/home/ada")).toEqual(["/home/ada/.intentic/ic/bin/ic", "/usr/local/bin/ic", "ic"]);
    expect(icCandidates("win32", "C:\\Users\\Ada")).toEqual(["C:\\Users\\Ada\\.intentic\\ic\\bin\\ic.exe", "ic.exe"]);
});

// ic grows verbs in the same release the agent starts using them, so an agent keeps the ic it runs at least as new as
// itself. A working-tree agent has no release to fetch and leaves the developer's ic alone.
test("an ic older than the agent, or none, is fetched; a newer one and a dev agent are left alone", () => {
    expect(icVersionFrom("ic 1.4.2\n")).toBe("1.4.2");
    expect(icVersionFrom("error: unexpected argument")).toBeUndefined();
    expect(icNeedsFetch("1.4.1", "1.4.2")).toBe(true);
    expect(icNeedsFetch(undefined, "1.4.2")).toBe(true);
    expect(icNeedsFetch("1.4.2", "1.4.2")).toBe(false);
    expect(icNeedsFetch("1.10.0", "1.9.0")).toBe(false);
    expect(icNeedsFetch(undefined, "0.0.0")).toBe(false);
});

// The optional ops are advertised from what the device's ic says it has, not from a list written beside the agent: an
// agent whose ic cannot take the contract's shape must not be sent an op it would run against a flag that is not there.
test("advertises an optional op only when the ic under the agent takes the contract's shape", () => {
    const shape = "Usage: ic sandbox shape [OPTIONS] <SLUG>\n      --set <FIELD=JSON>\n      --when <WHEN>";
    expect(featuresFrom(shape)).toEqual(["reshape-later", "set-shape"]);
    // An ic from before `--set` has the verb but not the shape as the contract spells it.
    expect(featuresFrom("Usage: ic sandbox shape [OPTIONS] <SLUG>\n      --when <WHEN>")).toEqual([]);
    expect(featuresFrom(undefined)).toEqual([]);
});

// A log is a stream of chunks whose boundaries fall anywhere: a line split across two chunks is one line, and a blank
// line is the log's own spacing, not noise to drop.
test("a streamed run's lines survive chunk boundaries and keep their blank lines", () => {
    const lines: string[] = [];
    const split = lineSplitter((line) => lines.push(line));
    split.push("first half of a long ");
    split.push("line\n\nafter a blank\r");
    split.push("\nlast without a newline");
    expect(lines).toEqual(["first half of a long line", "", "after a blank"]);
    split.end();
    expect(lines).toEqual(["first half of a long line", "", "after a blank", "last without a newline"]);
    // A final newline ends the last line; it does not start an empty one.
    const ended: string[] = [];
    const tidy = lineSplitter((line) => ended.push(line));
    tidy.push("one\n");
    tidy.end();
    expect(ended).toEqual(["one"]);
});

// A failed fetch used to vanish: the old ic kept answering, the device's features shrank, and nothing said why. It is
// logged with its reason, and the same sentence is what the device reports beside its features.
test("a failed fetch of the current ic is logged with its reason and names the stale ic", async () => {
    const warned: string[] = [];
    const note = await fetchIc("/nonexistent-intentic-test/ic", "1.300.0", "1.313.0", {
        download: async () => {
            throw new Error("HTTP 404 for ic-linux-x64");
        },
        warn: (line) => warned.push(line),
    });
    expect(note).toContain("ic is out of date");
    expect(note).toContain("1.300.0");
    expect(note).toContain("1.313.0");
    expect(note).toContain("HTTP 404 for ic-linux-x64");
    expect(warned).toEqual([note!]);
    // No ic at all is said as such rather than as a version.
    expect(await fetchIc("/nonexistent-intentic-test/ic", undefined, "1.313.0", { download: async () => await Promise.reject(new Error("offline")), warn: () => {} })).toContain("none is installed");
});

test("a machine with no home still tries the rest", () => {
    expect(icCandidates("linux", undefined)).toEqual(["/usr/local/bin/ic", "ic"]);
    expect(icCandidates("win32", undefined)).toEqual(["ic.exe"]);
});

test("swapping is refused by the sandboxes switch, like managing", async () => {
    await expect(swapSandbox("update", "work", undefined, scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(/Manage sandboxes on this device/);
});

// One switch for the whole lifecycle: a fleet the owner may manage is one the owner may clean up, and the refusal
// they get for trying names the switch the card actually has.
test("removal is refused by the sandboxes switch, like every other verb", async () => {
    await expect(removeSandbox("work", scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(ScopeError);
    await expect(removeSandbox("work", scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(/Manage sandboxes on this device/);
});

test("reading a log is covered by either grant, like listing", async () => {
    await expect(sandboxLogs("work", 50, scopes({ shell: "off", sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this device/);
});

// The Devices view's Logs button reaches the same reading through the flow door, gated the same way: this one
// is a READ travelling a route whose other seven ops write.
test("the log flow is gated exactly like the log tool it shares a reading with", async () => {
    await expect(tailSandboxLogs("work", scopes({ shell: "off", sandboxes: "off" }), () => {})).rejects.toThrow(/Manage sandboxes on this device/);
});
