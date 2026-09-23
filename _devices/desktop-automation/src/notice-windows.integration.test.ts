import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { spawnNotice } from "./notice-windows.js";
import type { NoticeEvents } from "./types.js";

/* The helper's plumbing, with a real process standing in for powershell.exe: it logs every line it is sent to a
   file, answers each "show" with a hotkey press, and in its two other modes dies at once or ignores "quit". */

const STAND_IN = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, mode] = process.argv.slice(2);
appendFileSync(log, "pid " + process.pid + "\\n");
if (mode === "dies") {
    process.stderr.write("Windows would not keep the notice\\nout of screen captures\\n");
    process.exit(1);
}
process.stdout.write("hotkey-taken\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
    appendFileSync(log, line + "\\n");
    if (line.startsWith("show ")) process.stdout.write("hotkey\\n");
    if (line === "quit" && mode !== "stubborn") process.exit(0);
});
if (mode === "stubborn") setInterval(() => undefined, 1_000);
`;

let dir = "";
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "notice-"));
    await writeFile(join(dir, "helper.mjs"), STAND_IN);
});
afterEach(async () => await rm(dir, { recursive: true, force: true }));

// Every event, in order, as a line; `exited` with what it was told.
const recording = (): { readonly events: NoticeEvents; readonly heard: string[] } => {
    const heard: string[] = [];
    return {
        heard,
        events: {
            hotkey: () => void heard.push("hotkey"),
            hotkeyTaken: () => void heard.push("hotkey-taken"),
            exited: (said) => void heard.push(`exited: ${said}`),
        },
    };
};

const start = (mode: "answers" | "dies" | "stubborn", events: NoticeEvents) =>
    spawnNotice(process.execPath, [join(dir, "helper.mjs"), join(dir, "log"), mode], events);

const sent = async (): Promise<string[]> => (await readFile(join(dir, "log"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

// Whether a process is still there, asked without touching it.
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const pidOf = async (): Promise<number> => Number((await sent())[0]?.replace("pid ", ""));

test("text goes to the helper as one line per show, and what the helper says comes back as events", async () => {
    const { events, heard } = recording();
    const notice = start("answers", events);
    notice.show("Intentic agent is controlling this computer");
    notice.show("two\nlines");
    await waitFor(() => expect(heard).toEqual(["hotkey-taken", "hotkey", "hotkey"]), SETTLES);
    expect((await sent()).slice(1)).toEqual(["show Intentic agent is controlling this computer", "show two lines"]);
    notice.close();
});

test("a closed helper is told to quit, goes, and neither it nor its going is heard from again", async () => {
    const { events, heard } = recording();
    const notice = start("answers", events);
    notice.show("before");
    await waitFor(() => expect(heard).toEqual(["hotkey-taken", "hotkey"]), SETTLES);
    const pid = await pidOf();

    notice.close();
    notice.show("after");
    await waitFor(() => expect(alive(pid)).toBe(false), SETTLES);
    expect((await sent()).slice(1)).toEqual(["show before", "quit"]);
    expect(heard).toEqual(["hotkey-taken", "hotkey"]);
});

test("a helper that ignores quit is killed, so a wedged one cannot stay on screen", async () => {
    const { events, heard } = recording();
    const notice = start("stubborn", events);
    await waitFor(() => expect(heard).toEqual(["hotkey-taken"]), SETTLES);
    const pid = await pidOf();

    notice.close();
    await waitFor(() => expect(alive(pid)).toBe(false), SETTLES);
    expect(heard).toEqual(["hotkey-taken"]);
});

test("a helper that dies by itself is heard once, in its own words on one line", async () => {
    const { events, heard } = recording();
    start("dies", events);
    await waitFor(() => expect(heard).toEqual(["exited: Windows would not keep the notice out of screen captures"]), SETTLES);
});

test("a helper that cannot be started is heard as gone, with the reason", async () => {
    const { events, heard } = recording();
    spawnNotice(join(dir, "no-such-program"), [], events);
    await waitFor(() => expect(heard).toEqual([expect.stringMatching(/^exited: .*ENOENT/)]), SETTLES);
});
