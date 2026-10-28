import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "../index.ts";
import {
    endedNote,
    freePreviewPort,
    hostLabel,
    idleRecords,
    noteStop,
    overCap,
    parseRecord,
    preferredPort,
    PREVIEW_PORTS,
    readRecords,
    recordPath,
    startTicksOf,
    stopPreview,
    touchRecord,
    writeRecord,
    pidNamespaceOf,
    type PreviewRecord,
    // @ts-expect-error -- hand-written .mjs with a .d.mts beside it; see mirror-roots.mjs for why it isn't compiled.
} from "../dev-previews.mjs";

// Temp trees for the records and a hand-made /proc for the processes they name; one real child for the stop.

const NAMESPACE = "pid:[4026531836]";

const fakeProc = (): string => {
    const root = mkdtempSync(join(tmpdir(), "previews-proc-"));
    mkdirSync(join(root, "self", "ns"), { recursive: true });
    symlinkSync(NAMESPACE, join(root, "self", "ns", "pid"));
    return root;
};

// One process as procfs shows it: field 22 of its stat is its start tick, its environ carries the owner stamp.
const fakeProcess = (proc: string, pid: number, ticks: string, owner: string): void => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    const fields = ["S", ...Array.from({ length: 18 }, () => "0"), ticks, "0"];
    writeFileSync(join(proc, String(pid), "stat"), `${String(pid)} (node (vite)) ${fields.join(" ")}\n`);
    writeFileSync(join(proc, String(pid), "environ"), `PATH=/bin\0INTENTIC_TURN_OWNER=${owner}\0`);
};

const record = (overrides: Partial<PreviewRecord> = {}): PreviewRecord => ({
    v: 1,
    conversation: "brave-maple-ilnz",
    label: "demo",
    pid: 4242,
    startTicks: "900",
    pidNamespace: NAMESPACE,
    port: 47160,
    url: "http://brave-maple-ilnz.demo.localhost:47160/demo/",
    root: join(WORKSPACE_ROOT, "intentic", "_site", "demo"),
    log: "/tmp/intentic-previews/brave-maple-ilnz--demo.log",
    startedAt: 1_000,
    lastActiveAt: 1_000,
    ...overrides,
});

describe("a preview record", () => {
    test("is read back as written, and a record from before lastActiveAt counts its start as its last use", () => {
        expect(parseRecord(JSON.stringify(record()))).toEqual(record());
        const { lastActiveAt: _dropped, ...older } = record({ startedAt: 5_000 });
        expect(parseRecord(JSON.stringify(older))?.lastActiveAt).toBe(5_000);
    });

    test("is refused when its address leaves loopback or its fields do not mean what they must", () => {
        expect(parseRecord(JSON.stringify(record({ url: "http://example.com:47160/demo/" })))).toBeUndefined();
        expect(parseRecord(JSON.stringify(record({ pid: 1 })))).toBeUndefined();
        expect(parseRecord(JSON.stringify(record({ port: 70_000 })))).toBeUndefined();
        expect(parseRecord("{half")).toBeUndefined();
        expect(parseRecord(JSON.stringify(record({ url: "http://127.0.0.1:47160/demo/" })))?.url).toBe("http://127.0.0.1:47160/demo/");
    });

    test("names its conversation as one hostname label", () => {
        expect(hostLabel("brave-maple-ilnz")).toBe("brave-maple-ilnz");
        expect(hostLabel("Sub_Spry:falcon")).toBe("sub-spry-falcon");
        expect(hostLabel("___")).toBe("preview");
        expect(hostLabel("---Sub__Spry:falcon---")).toBe("sub-spry-falcon");
        expect(hostLabel("a--b")).toBe("a--b");
        expect(hostLabel("a".repeat(70))).toBe("a".repeat(63));
        expect(hostLabel("")).toBe("preview");
    });

    test("trims long hyphen runs without freezing the caller", () => {
        // A child deadline catches a backtracking regression without blocking this worker.
        const module = new URL("../dev-previews.mjs", import.meta.url).href;
        const result = execFileSync(
            process.execPath,
            [
                "--eval",
                `import { hostLabel } from ${JSON.stringify(module)};
                 const labels = ["a" + "-".repeat(200_000) + "b", "-".repeat(200_000), "---a" + "-".repeat(200_000)];
                 console.log(JSON.stringify(labels.map(hostLabel)));`,
            ],
            { encoding: "utf8", timeout: 5_000 },
        );
        expect(JSON.parse(result)).toEqual([`a${"-".repeat(62)}`, "preview", "a"]);
    });
});

describe("reading the records", () => {
    test("keeps a live one, retires a dead one with its stop reason, and leaves another namespace's alone", () => {
        const dir = mkdtempSync(join(tmpdir(), "previews-"));
        const proc = fakeProc();
        fakeProcess(proc, 4242, "900", "brave-maple-ilnz");
        // 5151 now runs something else: same pid, a later start tick.
        fakeProcess(proc, 5151, "1200", "quick-condor-0a8q");
        writeRecord(dir, record());
        const dead = record({ conversation: "quick-condor-0a8q", pid: 5151, startTicks: "300", port: 47161, url: "http://quick-condor-0a8q.demo.localhost:47161/demo/" });
        writeRecord(dir, dead);
        noteStop(dir, dead, "idle: no request for 10 minutes and no open page");
        const foreign = record({ conversation: "domain-turn-x1", pidNamespace: "pid:[4026532999]", pid: 7, port: 47162, url: "http://127.0.0.1:47162/demo/" });
        writeRecord(dir, foreign);
        writeFileSync(join(dir, "stray.json"), "not json");

        expect(readRecords(dir, proc).map((one) => one.conversation)).toEqual(["brave-maple-ilnz"]);
        expect(endedNote(dir, "quick-condor-0a8q", "demo")?.reason).toBe("idle: no request for 10 minutes and no open page");
        expect(readdirSync(dir).toSorted()).toEqual(["brave-maple-ilnz--demo.json", "domain-turn-x1--demo.json", "quick-condor-0a8q--demo.ended"]);
    });

    test("a process carrying another conversation's stamp is not the record's", () => {
        const dir = mkdtempSync(join(tmpdir(), "previews-"));
        const proc = fakeProc();
        fakeProcess(proc, 4242, "900", "someone-else");
        writeRecord(dir, record());
        expect(readRecords(dir, proc)).toEqual([]);
        expect(endedNote(dir, "brave-maple-ilnz", "demo")).toBeUndefined();
    });

    test("a touch only ever moves the last use later", () => {
        const dir = mkdtempSync(join(tmpdir(), "previews-"));
        const path = writeRecord(dir, record({ lastActiveAt: 5_000 }));
        expect(touchRecord(path, 9_000)?.lastActiveAt).toBe(9_000);
        expect(touchRecord(path, 7_000)?.lastActiveAt).toBe(9_000);
        expect(touchRecord(join(dir, "gone.json"), 9_000)).toBeUndefined();
    });
});

describe("keeping the number down", () => {
    const three = [record({ conversation: "a", lastActiveAt: 30 }), record({ conversation: "b", lastActiveAt: 10 }), record({ conversation: "c", lastActiveAt: 20 })];

    test("a fourth start stops the least recently used, and a start under the cap stops nothing", () => {
        expect(overCap(three, 3).map((one) => one.conversation)).toEqual(["b"]);
        expect(overCap(three, 2).map((one) => one.conversation)).toEqual(["b", "c"]);
        expect(overCap(three.slice(0, 2), 3)).toEqual([]);
    });

    test("idle means unused for the whole bound, measured from the last use", () => {
        expect(idleRecords(three, 10 + 600_000, 600_000).map((one) => one.conversation)).toEqual(["b"]);
        expect(idleRecords(three, 9 + 600_000, 600_000)).toEqual([]);
    });
});

describe("ports", () => {
    test("a conversation asks for the same port every time, inside the preview range", () => {
        const port = preferredPort("brave-maple-ilnz");
        expect(preferredPort("brave-maple-ilnz")).toBe(port);
        expect(port).toBeGreaterThanOrEqual(PREVIEW_PORTS.first);
        expect(port).toBeLessThanOrEqual(PREVIEW_PORTS.last);
    });

    test("a taken or busy port is passed over, wrapping at the end of the range", async () => {
        const busy = new Set([PREVIEW_PORTS.last]);
        const free = (port: number): Promise<boolean> => Promise.resolve(!busy.has(port));
        expect(await freePreviewPort(new Set([PREVIEW_PORTS.last - 1]), PREVIEW_PORTS.last - 1, free)).toBe(PREVIEW_PORTS.first);
        expect(await freePreviewPort(new Set(), PREVIEW_PORTS.first, () => Promise.resolve(false))).toBeUndefined();
    });
});

describe("stopping a preview", () => {
    test("signals its process group, and leaves the reason as the ended note", async () => {
        const dir = mkdtempSync(join(tmpdir(), "previews-"));
        const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore", env: { ...process.env, INTENTIC_TURN_OWNER: "brave-maple-ilnz" } });
        const exited = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
        const pid = child.pid ?? 0;
        // The stat is readable as soon as spawn returns a pid; its start tick is what the record holds.
        const live = record({ pid, startTicks: startTicksOf(pid) ?? "", pidNamespace: pidNamespaceOf() });
        writeRecord(dir, live);
        expect(readRecords(dir).map((one) => one.pid)).toEqual([pid]);

        await stopPreview(dir, live, "cap: at most 3 previews run at once, and this one was used least recently", { graceMs: 2_000 });

        expect(await exited).toBe("SIGTERM");
        expect(readdirSync(dir)).toEqual(["brave-maple-ilnz--demo.ended"]);
        expect(endedNote(dir, "brave-maple-ilnz", "demo")?.reason).toBe("cap: at most 3 previews run at once, and this one was used least recently");
        expect(recordPath(dir, "brave-maple-ilnz", "demo")).toBe(join(dir, "brave-maple-ilnz--demo.json"));
    });
});
