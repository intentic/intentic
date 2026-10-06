import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, pngPath } from "./screen.js";

/* Linux, a Wayland session, and a PATH holding only the screenshot tools a test puts there: which grabbers exist is
   the whole question, so the ambient machine's own must not answer it. */

const ENV_KEYS = ["PATH", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "DISPLAY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const pathWith = async (tools: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "screen-tools-"));
    await Promise.all(
        Object.entries(tools).map(async ([name, script]) => {
            await writeFile(join(dir, name), `#!/bin/sh\n${script}\n`);
            await chmod(join(dir, name), 0o755);
        }),
    );
    return dir;
};

beforeEach(() => {
    process.env["WAYLAND_DISPLAY"] = "wayland-0";
    process.env["XDG_SESSION_TYPE"] = "wayland";
    delete process.env["DISPLAY"];
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = saved[key];
        }
    }
});

// Telling someone to install a tool they already have sends them the wrong way; what the tool said is the lead.
test("an installed tool that fails is named with what it said, not reported as no tool at all", async () => {
    process.env["PATH"] = await pathWith({ grim: `echo "compositor doesn't support wlr-screencopy-unstable-v1" >&2; exit 1` });
    await expect(capture()).rejects.toThrow("Could not capture the screen. grim: compositor doesn't support wlr-screencopy-unstable-v1");
});

test("a device with no screenshot tool is told what to install", async () => {
    process.env["PATH"] = await pathWith({});
    await expect(capture()).rejects.toThrow("No screenshot tool on this device.");
});

// Two captures started in the same millisecond (parallel tool calls) share a name made of the pid and the clock, so one
// deletes, or overwrites, the file the other is about to read.
test("each capture writes to a file of its own, even in the same millisecond", () => {
    const now = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
        expect(new Set(Array.from({ length: 50 }, () => pngPath())).size).toBe(50);
    } finally {
        Date.now = now;
    }
});
