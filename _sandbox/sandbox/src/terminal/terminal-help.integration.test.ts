import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { liveWindow, selectWindow } from "./terminal-help.js";
import { captureScrollback } from "./terminal-session.js";

// Which window the owner lands on, against a real tmux server: not the newest, but the one still waiting at a prompt,
// since later commands leave dead panes behind it. All waits poll a condition rather than sleep.

const execFileAsync = promisify(execFile);
const HAS_TMUX = existsSync("/usr/bin/tmux");
// agent-shaped (the real derivation is agent- + 8 chars) and unique to this process.
const SESSION = `agent-t${String(process.pid).slice(-7).padStart(7, "0")}`;

// A window whose command finishes but whose pane STAYS, exactly as tmux-run leaves one.
const finished = (echo: string): string => `bash -c 'tmux set-option -w -t "$TMUX_PANE" remain-on-exit on; echo ${echo}'`;
// A window whose command sits at a prompt: what a handover parks on.
const waiting = `bash -c 'read -p "OTP: " code; echo "got $code"'`;

const kill = async (): Promise<void> => void (await execFileAsync("tmux", ["kill-session", "-t", `=${SESSION}`]).catch(() => undefined));
afterAll(kill);

// Waits until the window has actually reached the wanted state (dead pane, or alive with its prompt printed), so
// assertions test tmux's answer, not this machine's load.
const addWindow = async (name: string, command: string, settled: "dead" | "waiting"): Promise<void> => {
    await execFileAsync("tmux", ["new-window", "-t", `=${SESSION}:`, "-n", name, command]);
    await vi.waitFor(async () => {
        const { stdout } = await execFileAsync("tmux", ["list-panes", "-s", "-t", `=${SESSION}`, "-F", "#{window_name} #{pane_dead}"]);
        const pane = stdout.split("\n").find((line) => line.startsWith(`${name} `));
        expect(pane).toBe(`${name} ${settled === "dead" ? "1" : "0"}`);
        if (settled === "waiting") {
            expect((await captureScrollback(SESSION, 50))?.text ?? "").toContain("OTP:");
        }
    }, SETTLES);
};

test.skipIf(!HAS_TMUX)("the owner lands on the window still waiting, not on the newest one", async () => {
    await kill();
    // Oldest to newest: finished, waiting, finished again, so newest and needs-a-person are different windows.
    await execFileAsync("tmux", ["new-session", "-d", "-s", SESSION, "-n", "install", finished("installed")]);
    await addWindow("publish", waiting, "waiting");
    await addWindow("git-status", finished("clean"), "dead");

    const picked = await liveWindow(SESSION);
    expect(picked?.name).toBe("publish");

    // And selecting it is what an attaching client opens on: without this the owner gets git-status.
    await selectWindow(picked!.id);
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", `=${SESSION}:`, "#{window_name}"]);
    expect(stdout.trim()).toBe("publish");

    // The hand-back reads THAT pane, which is how the agent sees the prompt it could not answer.
    expect((await captureScrollback(SESSION, 50))?.text).toContain("OTP:");

    // Answers it as the owner would; nothing left waiting triggers the tool's own refusal case, not a handover.
    await execFileAsync("tmux", ["send-keys", "-t", `=${SESSION}:publish`, "123456", "Enter"]);
    await vi.waitFor(async () => expect(await liveWindow(SESSION)).toBeUndefined(), SETTLES);
});

// No session at all, the first thing the tool asks on a fresh turn; answers nothing to hand over, not a throw.
test.skipIf(!HAS_TMUX)("a session that does not exist has nothing to hand over", async () => {
    expect(await liveWindow("agent-nosuchsession")).toBeUndefined();
});
