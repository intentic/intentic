import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { PREVIEW_IDLE_MS, type PreviewRecord, writeRecord } from "@intentic/constants/dev-previews";
import { createPreviewKeeper, withPreviewHolders } from "./dev-previews.js";

// Records in a temp dir naming processes in a hand-made /proc; the stop and the connection check are the keeper's
// seams, so nothing here signals a real process.

const NAMESPACE = "pid:[4026531836]";
const NOW = 10_000_000;

const fakeProc = (processes: readonly { readonly pid: number; readonly owner: string }[]): string => {
    const root = mkdtempSync(join(tmpdir(), "keeper-proc-"));
    mkdirSync(join(root, "self", "ns"), { recursive: true });
    symlinkSync(NAMESPACE, join(root, "self", "ns", "pid"));
    for (const { pid, owner } of processes) {
        mkdirSync(join(root, String(pid)));
        const fields = ["S", ...Array.from({ length: 18 }, () => "0"), `${String(pid)}00`, "0"];
        writeFileSync(join(root, String(pid), "stat"), `${String(pid)} (node) ${fields.join(" ")}\n`);
        writeFileSync(join(root, String(pid), "environ"), `INTENTIC_TURN_OWNER=${owner}\0`);
    }
    return root;
};

const record = (conversation: string, pid: number, lastActiveAt: number): PreviewRecord => ({
    v: 1,
    conversation,
    label: "demo",
    pid,
    startTicks: `${String(pid)}00`,
    pidNamespace: NAMESPACE,
    port: 47150 + (pid % 50),
    url: `http://${conversation}.demo.localhost:${String(47150 + (pid % 50))}/demo/`,
    root: join(WORKSPACE_ROOT, "intentic", "_site", "demo"),
    log: "/tmp/x.log",
    startedAt: lastActiveAt,
    lastActiveAt,
});

const setup = (records: readonly PreviewRecord[], connectedPorts: readonly number[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const proc = fakeProc(records.map((one) => ({ pid: one.pid, owner: one.conversation })));
    for (const one of records) {
        writeRecord(dir, one);
    }
    const stops: { readonly conversation: string; readonly reason: string }[] = [];
    const keeper = createPreviewKeeper({
        logger: { info: () => undefined, warn: () => undefined },
        dir,
        procRoot: proc,
        now: () => NOW,
        connected: (ports) => Promise.resolve(ports.some((port) => connectedPorts.includes(port))),
        stop: (_dir, stopped, reason) => {
            stops.push({ conversation: stopped.conversation, reason });
            return Promise.resolve();
        },
    });
    return { keeper, stops };
};

test("a live preview is handed to the reaper as a pane, beside the real panes", async () => {
    const { keeper, stops } = setup([record("brave-maple-ilnz", 4242, NOW - 60_000)]);
    const panes = withPreviewHolders(() => Promise.resolve(new Map([[100, "agent-x"]])), keeper);
    expect([...(await panes())]).toEqual([
        [100, "agent-x"],
        [4242, "preview:brave-maple-ilnz--demo"],
    ]);
    expect(stops).toEqual([]);
});

test("a preview its own idle stop missed is stopped once overdue with nobody connected, and not before", async () => {
    const overdue = NOW - PREVIEW_IDLE_MS - 5 * 60_000;
    const { keeper, stops } = setup([record("idle-one", 4243, overdue), record("idle-but-open", 4244, overdue), record("just-idle", 4245, NOW - PREVIEW_IDLE_MS)], [47150 + (4244 % 50)]);
    expect([...(await keeper.holders()).keys()]).toEqual([4244, 4245]);
    expect(stops).toEqual([{ conversation: "idle-one", reason: "idle: unused for over 10 minutes, and its own idle stop had not ended it" }]);
});

test("past the cap the least recently used is stopped, with the reason its conversation will be told", async () => {
    const { keeper, stops } = setup([
        record("a", 4301, NOW - 4_000),
        record("b", 4302, NOW - 1_000),
        record("c", 4303, NOW - 3_000),
        record("d", 4304, NOW - 2_000),
    ]);
    expect([...(await keeper.holders()).keys()].toSorted()).toEqual([4302, 4303, 4304]);
    expect(stops).toEqual([{ conversation: "a", reason: "cap: more than 3 were running, and this one was used least recently" }]);
});
