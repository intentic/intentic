import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, expect, test, vi } from "vitest";
import { liveWindow, selectWindow } from "./terminal-help.js";
import { captureScrollback } from "./terminal-session.js";

/* WHICH WINDOW THE OWNER IS SENT TO, against a REAL tmux server — the one piece of the terminal handover that
 * is tmux's answer rather than ours, and the one a stub could only confirm the flags of.
 *
 * The shape being pinned is the shape an agent's session actually has mid-turn: several windows, most of them
 * FINISHED commands left behind as dead panes (tmux-run sets remain-on-exit so their output stays readable),
 * and somewhere among them the one command still waiting at a prompt. The handover has to land the owner on
 * that one — and it is deliberately NOT the newest window here, because the newest is the trap: an agent runs
 * a `git status` after its publish stalls, and picking "the last window" would send the owner to a dead pane
 * with the real prompt one keystroke away in a tab they were never shown.
 *
 * NO TAB IN A `-F` FORMAT, here or in the code under test. tmux sanitizes what it prints back to a client
 * whose locale does not say UTF-8, and every control character comes back as an underscore. In an image that
 * sets no LANG — CI's, where this runs; not the sandbox's, where the daemon does — a tab-separated window
 * line reads `publish_0`, so nothing below finds a window at all. A space says the same thing in every locale.
 *
 * EVERY WAIT IS A POLL, never a sleep. This test drives the machine's SHARED tmux server while the rest of the
 * suite runs beside it, so "a command has surely started by now" is a guess about a loaded box — and the shape
 * of that guess going wrong is an intermittent failure in somebody else's afternoon. The session name carries
 * the pid for the same reason: a run that was killed before its cleanup must not hand the next one a session
 * it did not create.
 *
 * Skipped where tmux is not installed (a dev machine outside the image), like the rest of this seam.
 */

const execFileAsync = promisify(execFile);
const HAS_TMUX = existsSync("/usr/bin/tmux");
// agent-shaped (the real derivation is `agent-` + 8 chars) and unique to this process.
const SESSION = `agent-t${String(process.pid).slice(-7).padStart(7, "0")}`;

// A window whose command finishes but whose pane STAYS, exactly as tmux-run leaves one.
const finished = (echo: string): string => `bash -c 'tmux set-option -w -t "$TMUX_PANE" remain-on-exit on; echo ${echo}'`;
// A window whose command sits at a prompt — what a handover parks on.
const waiting = `bash -c 'read -p "OTP: " code; echo "got $code"'`;

const kill = async (): Promise<void> => void (await execFileAsync("tmux", ["kill-session", "-t", `=${SESSION}`]).catch(() => undefined));
afterAll(kill);

// Add a window and wait until it has actually reached the state the test needs it in — a finished one until
// its pane is dead, a waiting one until it is alive and has printed its prompt. Polling on the CONDITION is
// what makes the assertions below about tmux's answer rather than about this machine's load.
const addWindow = async (name: string, command: string, settled: "dead" | "waiting"): Promise<void> => {
    await execFileAsync("tmux", ["new-window", "-t", `=${SESSION}:`, "-n", name, command]);
    await vi.waitFor(
        async () => {
            const { stdout } = await execFileAsync("tmux", ["list-panes", "-s", "-t", `=${SESSION}`, "-F", "#{window_name} #{pane_dead}"]);
            const pane = stdout.split("\n").find((line) => line.startsWith(`${name} `));
            expect(pane).toBe(`${name} ${settled === "dead" ? "1" : "0"}`);
            if (settled === "waiting") {
                expect((await captureScrollback(SESSION, 50))?.text ?? "").toContain("OTP:");
            }
        },
        { timeout: 10_000, interval: 50 },
    );
};

test.skipIf(!HAS_TMUX)("the owner lands on the window still waiting, not on the newest one", async () => {
    await kill();
    // Oldest: a finished command. Then the one waiting at its prompt. Then ANOTHER finished one on top of it,
    // so "newest window" and "the window that needs a person" are different answers.
    await execFileAsync("tmux", ["new-session", "-d", "-s", SESSION, "-n", "install", finished("installed")]);
    await addWindow("publish", waiting, "waiting");
    await addWindow("git-status", finished("clean"), "dead");

    const picked = await liveWindow(SESSION);
    expect(picked?.name).toBe("publish");

    // And selecting it is what an attaching client opens on — without this the owner gets `git-status`.
    await selectWindow(picked!.id);
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", `=${SESSION}:`, "#{window_name}"]);
    expect(stdout.trim()).toBe("publish");

    // The hand-back reads THAT pane, which is how the agent sees the prompt it could not answer.
    expect((await captureScrollback(SESSION, 50))?.text).toContain("OTP:");

    // Answer it the way the owner would, and the session has nothing waiting left — which is the tool's own
    // refusal case ("nothing is waiting in your terminal") rather than a handover onto a dead pane.
    await execFileAsync("tmux", ["send-keys", "-t", `=${SESSION}:publish`, "123456", "Enter"]);
    await vi.waitFor(async () => expect(await liveWindow(SESSION)).toBeUndefined(), { timeout: 10_000, interval: 50 });
});

// No session at all — the first thing the tool asks, on a turn that has run no command yet. It must answer
// "nothing to hand over" rather than throwing out of a `tmux` that exits non-zero.
test.skipIf(!HAS_TMUX)("a session that does not exist has nothing to hand over", async () => {
    expect(await liveWindow("agent-nosuchsession")).toBeUndefined();
});
