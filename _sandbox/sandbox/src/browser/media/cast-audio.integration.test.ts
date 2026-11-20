import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { probe } from "./display-command.js";
import { ensureWindowSound, stopSoundServer } from "./cast-audio.js";

// A window's sound on a real PulseAudio, in a directory of the test's own: its own sink for what it plays, and a
// microphone that hears nothing, so a page given the microphone can never record another window's sink.

const pulse = requires(existsSync("/usr/bin/pulseaudio") && existsSync("/usr/bin/pactl"), "PulseAudio", {
    absentOnCi: "no CI job that runs the daemon's suites installs the browser pack, which carries PulseAudio",
});

let dir = "";
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cast-audio-"));
});
afterAll(async () => {
    await stopSoundServer(dir);
    rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!pulse.runs)(pulse.title("each window records from a silent source of its own making, never another window's sink"), async () => {
    const one = await ensureWindowSound(":150", dir);
    const two = await ensureWindowSound(":151", dir);
    expect(one?.microphone).toEqual(expect.any(String));
    expect(two?.microphone).toBe(one?.microphone);
    // What a page's getUserMedia would open (PULSE_SOURCE): a source of its own, never a sink's monitor.
    const sources = (await probe(["/usr/bin/pactl", "--server", one?.server ?? "", "list", "short", "sources"])) ?? "";
    const names = sources.split("\n").map((line) => line.split("\t")[1]);
    expect(names).toContain(one?.microphone);
    expect(one?.microphone?.endsWith(".monitor")).toBe(false);
    expect([one?.source, two?.source]).toEqual(["x150.monitor", "x151.monitor"]);
}, 30_000);
