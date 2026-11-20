import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pollUntil, SingleFlight } from "@intentic/base/async";
import { spawnAs } from "../../workload/workload-class.js";
import { CAST_DIR } from "./media-token.js";
import { probe } from "./display-command.js";

/* A window's sound. One PulseAudio server for the sandbox's displays, on a socket in the cast directory, with a null
   sink per display: the window's Chromium plays into its own sink (PULSE_SERVER and PULSE_SINK at its launch,
   owner-browser.ts), and that display's castd sends the sink's monitor as Opus on the media socket. Nothing reaches a
   speaker, and two windows never hear each other. Its microphone (PULSE_SOURCE) is a null source that hears nothing:
   left to Pulse's default, a page given the microphone would record whichever sink's monitor Pulse fell back to,
   another window's sound included.

   The server is started on the first window that asks, detached like the displays, so a daemon restart finds it still
   running and keeps using it; it never exits on idle. Without PulseAudio installed (an image from before the browser
   pack carried it) there is no sound and nothing else changes. */

const PULSEAUDIO = "/usr/bin/pulseaudio";
const PACTL = "/usr/bin/pactl";

// Opus runs at 48 kHz; a sink at Pulse's default 44.1 would be resampled once more on the way.
const SINK_RATE = 48_000;

export interface WindowSound {
    // PULSE_SERVER for whatever plays into or records from it.
    readonly server: string;
    // PULSE_SINK for the window's Chromium.
    readonly sink: string;
    // castd's `--audio-source`: the sink's monitor.
    readonly source: string;
    // PULSE_SOURCE for the window's Chromium: a source that hears nothing, shared by every window.
    readonly microphone: string;
}

// The silent source every window's Chromium records from.
const MICROPHONE = "intentic_silence";

// The sink a display's window plays into, named by its number: `:99` → `x99`. A number is one display at a time, and
// its sink goes with it (releaseWindowSound).
const sinkOf = (display: string): string => `x${display.replace(/^:/u, "").replace(/[^0-9]/gu, "")}`;

const soundServerOf = (dir: string): string => `unix:${join(dir, "pulse.sock")}`;

const pactl = (server: string, ...args: string[]): Promise<string | undefined> => probe([PACTL, "--server", server, ...args]);

const serverAnswers = async (server: string): Promise<boolean> => (await pactl(server, "info")) !== undefined;

// Starts the sandbox's sound server when nothing answers on its socket; resolves whether one answers now.
const startServer = async (dir: string): Promise<boolean> => {
    const server = soundServerOf(dir);
    if (await serverAnswers(server)) {
        return true;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // -n: no default script, so nothing reaches for a sound card, D-Bus or X; anonymous auth on a socket only the
    // sandbox's root reaches; no exit when idle, since a window opened tomorrow plays into it too.
    const child = spawnAs(
        { class: "service" },
        PULSEAUDIO,
        [
            "--daemonize=no",
            "-n",
            "--exit-idle-time=-1",
            "--use-pid-file=no",
            "--disable-shm=yes",
            "--log-target=stderr",
            "--log-level=error",
            "-L",
            `module-native-protocol-unix socket=${join(dir, "pulse.sock")} auth-anonymous=1`,
        ],
        { detached: true, stdio: "ignore", env: { ...process.env, HOME: dir } },
    );
    child.on("error", () => undefined);
    child.unref();
    return pollUntil(() => serverAnswers(server), { intervalMs: 100, timeoutMs: 5_000 });
};

const starting = new SingleFlight<string, boolean>();

const ensureServer = async (dir: string): Promise<boolean> => starting.joined(dir) ?? starting.run(dir, () => startServer(dir));

// The display's sink, made if it is not there yet; undefined when the sandbox has no PulseAudio or it would not start.
export const ensureWindowSound = async (display: string, dir: string = CAST_DIR): Promise<WindowSound | undefined> => {
    if (!existsSync(PULSEAUDIO) || !existsSync(PACTL) || !(await ensureServer(dir))) {
        return undefined;
    }
    const server = soundServerOf(dir);
    const sink = sinkOf(display);
    const sinks = (await pactl(server, "list", "short", "sinks")) ?? "";
    const present = sinks.split("\n").some((line) => line.split("\t")[1] === sink);
    if (!present && (await pactl(server, "load-module", "module-null-sink", `sink_name=${sink}`, `rate=${SINK_RATE}`, "channels=2", `sink_properties=device.description=${sink}`)) === undefined) {
        return undefined;
    }
    // Named whether or not it could be made: a PULSE_SOURCE that names nothing fails a recording rather than falling
    // back to another window's monitor.
    await ensureMicrophone(server);
    return { server, sink, source: `${sink}.monitor`, microphone: MICROPHONE };
};

// The silent source, made once per server.
const ensureMicrophone = async (server: string): Promise<void> => {
    const sources = (await pactl(server, "list", "short", "sources")) ?? "";
    if (!sources.split("\n").some((line) => line.split("\t")[1] === MICROPHONE)) {
        // module-null-source takes no source_properties (PulseAudio 17 refuses the load with them).
        await pactl(server, "load-module", "module-null-source", `source_name=${MICROPHONE}`, `rate=${SINK_RATE}`, "channels=2");
    }
};

// The sound a display's window would play into, without making it: for a reader that only passes it on.
export const windowSoundOf = (display: string, dir: string = CAST_DIR): WindowSound | undefined =>
    existsSync(join(dir, "pulse.sock")) ? { server: soundServerOf(dir), sink: sinkOf(display), source: `${sinkOf(display)}.monitor`, microphone: MICROPHONE } : undefined;

// Ends the sandbox's sound server: for a test that started one in a directory of its own. Best-effort.
export const stopSoundServer = async (dir: string = CAST_DIR): Promise<void> => {
    if (existsSync(join(dir, "pulse.sock"))) {
        await pactl(soundServerOf(dir), "exit");
    }
};

// Unloads the display's sink once the display is gone. Best-effort: a server that is not running holds no sink.
export const releaseWindowSound = async (display: string, dir: string = CAST_DIR): Promise<void> => {
    if (!existsSync(join(dir, "pulse.sock"))) {
        return;
    }
    const server = soundServerOf(dir);
    const sink = sinkOf(display);
    const modules = (await pactl(server, "list", "short", "modules")) ?? "";
    for (const line of modules.split("\n")) {
        const [index, name, args] = line.split("\t");
        if (index !== undefined && name === "module-null-sink" && args?.split(" ").includes(`sink_name=${sink}`) === true) {
            await pactl(server, "unload-module", index);
        }
    }
};
