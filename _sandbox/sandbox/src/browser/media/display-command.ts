import { runCheck } from "../../workload/run-check.js";

// A short X or PulseAudio command the media plane waits on (pactl, xdotool, xprop): run in the services' class and a
// group of its own, ended at five seconds. Its output when it exits 0; undefined otherwise, which every caller reads as
// "nothing there" (no server answering, a window already gone).
export const probe = async (argv: readonly string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> => {
    const outcome = await runCheck({ argv, env: env ?? process.env, timeoutMs: 5_000, workload: { class: "service" }, kind: "probe", captureBytes: 256 * 1024 });
    return outcome.exitCode === 0 ? outcome.stdout : undefined;
};
