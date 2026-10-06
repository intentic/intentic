import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceFlowLine } from "@intentic/sandbox-contract";
import { askedRestart, fileRestartResume } from "./restart-resume.js";

// The owner's "continue them once the sandbox is back", kept on the history volume across the restart it is about and
// read once by the boot after it. A rebuild that died before restarting must not make an unrelated later restart
// resume what it cuts, so an old ask reads as none, and every ask is spent by the first boot that reads it.

const MINUTE = 60_000;

test("the boot after an owner's restart reads the ask once", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-resume-"));
    await fileRestartResume(root).ask(1_000);
    // Another handle on the same file, as the next boot opens it.
    const boot = fileRestartResume(root);
    expect(await boot.take(1_000 + 20 * MINUTE)).toBe(true);
    expect(await boot.take(1_000 + 21 * MINUTE)).toBe(false);
});

test("nothing asked, withdrawn, or asked too long ago resumes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-resume-"));
    const marker = fileRestartResume(root);
    expect(await marker.take(1_000)).toBe(false);

    await marker.ask(1_000);
    await marker.withdraw();
    expect(await marker.take(2_000)).toBe(false);

    await marker.ask(1_000);
    expect(await marker.take(1_000 + 121 * MINUTE)).toBe(false);
    // Spent even though it was too old: the boot after that one must not read it either.
    await marker.ask(1_000);
    await marker.take(1_000 + 121 * MINUTE);
    expect(await marker.take(1_000 + MINUTE)).toBe(false);
});

const lines = async function* (frames: readonly DeviceFlowLine[]): AsyncGenerator<DeviceFlowLine> {
    yield* frames;
};
const drain = async (stream: AsyncIterable<DeviceFlowLine>): Promise<DeviceFlowLine[]> => {
    const seen: DeviceFlowLine[] = [];
    for await (const line of stream) {
        seen.push(line);
    }
    return seen;
};

test("a relayed swap keeps the ask through the cutover, and drops it when the machine answers in words", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-resume-"));
    const marker = fileRestartResume(root);
    // The stream stops mid-build: the daemon relaying it died at the cutover.
    expect(await drain(askedRestart(marker, 1_000, lines([{ kind: "line", text: "building" }])))).toEqual([{ kind: "line", text: "building" }]);
    expect(await marker.take(2_000)).toBe(true);

    // The machine refused, and this process lived to relay it: no restart is coming.
    await drain(askedRestart(marker, 1_000, lines([{ kind: "error", message: "Manage sandboxes is off." }])));
    expect(await marker.take(2_000)).toBe(false);

    // Unreachable before anything ran.
    const unreachable = async function* (): AsyncGenerator<DeviceFlowLine> {
        yield* [];
        throw new Error("rog is offline");
    };
    await expect(drain(askedRestart(marker, 1_000, unreachable()))).rejects.toThrow("rog is offline");
    expect(await marker.take(2_000)).toBe(false);

    // The link dropped once the machine had begun: its build goes on without the relay, and the restart still comes.
    const dropped = async function* (): AsyncGenerator<DeviceFlowLine> {
        yield { kind: "line", text: "building" };
        throw new Error("the link to rog closed");
    };
    await expect(drain(askedRestart(marker, 1_000, dropped()))).rejects.toThrow("the link to rog closed");
    expect(await marker.take(2_000)).toBe(true);
});
