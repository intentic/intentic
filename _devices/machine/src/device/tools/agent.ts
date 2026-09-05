import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isProcessAlive, spawnDetached } from "@intentic/local-agent";
import type { DeviceAgentOp, HostScopes } from "@intentic/sandbox-contract";
import { agentLogPath } from "../../config.js";
import { installedBuild } from "../../installed.js";
import { machineLauncher } from "../../resident.js";
import { assertScope } from "../policy.js";

/* UPDATING AND RESTARTING THIS DEVICE'S OWN AGENT, asked for from the browser.
 *
 * Both of these already existed as commands somebody could type (`intentic-machine upgrade`, and bare
 * `intentic-machine run`, which restarts: reconcileResidency stops before it starts). What did not exist was a
 * way to ASK for them from the Devices view — which is the view that reports the version, notices the skew and
 * names the remedy, and which had to name it as a command to go and find a terminal for.
 *
 * WHY THIS CANNOT SIMPLY RUN THE COMMAND. Every request over the device socket is served by the resident
 * process (resident.ts holds both the socket and the mirror watcher), and both of these operations stop that
 * process: `upgrade` calls stopResident() before it swaps the binary, `run` stops before it starts. So a child
 * spawned inline is a child of a process that is about to be SIGTERMed, and when the parent dies the child's
 * stdout pipe closes under it — an EPIPE on `process.stdout` is an uncaught exception in Node. Land that
 * between upgrade.ts's two renames and the device has no `intentic-machine` at all, with a login entry pointing
 * at a file that is gone. That is worse than being out of date, so it must not be reachable from a button.
 *
 * So the work is DETACHED FIRST and watched second: spawnDetached is exactly how this agent launches its own
 * resident loop (its stdio goes to a log file, it survives whoever started it), and this then tails that log
 * back to the reader for as long as this process is alive to do it. When the loop is stopped, this stream ends
 * mid-sentence — that is the expected ending, the browser is written for it, and the version on the next poll
 * is the confirmation. It is also the only trustworthy one: `upgrade`'s own `loop-behind` outcome exists
 * precisely because "a process came up" does not prove the new build is the one serving.
 *
 * The gate is "Run commands", not the sandbox switches: this is a command its owner could type, and it touches
 * no container. */

/* `intentic-machine <verb>`, and nothing caller-shaped ever reaches an argv here: the op is a two-member enum
 * in the contract and this is the whole of the mapping.
 *
 * `restart` is BARE `run`, not `run --stop` and not the two in sequence: reconcileResidency stops the loop it
 * finds before starting its own, so `run` is already the restart. `run --stop` would be half of one — a device
 * that stops its agent and never brings it back, from a button labelled Restart. */
export const AGENT_VERB: Record<DeviceAgentOp, string> = { upgrade: "upgrade", restart: "run" };

/* How long to keep reading the log after the detached run stops looking alive. `upgrade` replaces the binary
 * and then starts a new loop, so the pid we spawned exits before the last lines are necessarily flushed; a
 * short grace beats truncating the outcome line off the end of somebody's update. */
const DRAIN_MS = 1_500;
const POLL_MS = 250;

/* The ceiling on how long this streams for. Far above a 95 MB download on a slow line, and it exists only so a
 * reader whose device went quiet without closing the socket is not held forever: the run itself is detached and
 * finishes regardless of what happens to this stream. */
const WATCH_TIMEOUT_MS = 20 * 60 * 1000;

// What is in the log now, from `from` bytes on, as whole lines. Missing file = nothing yet, which is the
// ordinary first read: the detached process may not have written its first line when we start looking.
const readFrom = async (path: string, from: number): Promise<{ text: string; at: number }> => {
    const raw = await readFile(path, "utf8").catch(() => "");
    return { text: raw.slice(from), at: raw.length };
};

/* Start it, then narrate it.
 *
 * The answer is deliberately about what was STARTED rather than what it achieved: this process is usually not
 * alive to see the end, and a sentence claiming an outcome it did not witness is the failure mode the CLI's own
 * `loop-behind` outcome was added to stop. The reader confirms by the version moving.
 *
 * `onLine` is the same callback the sandbox flows take, so the router adapts this into a stream with no second
 * implementation of the streaming (see ../router.ts). */
export const runAgentOp = async (op: DeviceAgentOp, scopes: HostScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "shell");
    const installed = installedBuild();
    onLine(
        op === "upgrade"
            ? `Updating the agent on this device${installed === undefined ? "" : ` (currently ${installed})`}. Its background loop restarts, so this connection drops while that happens.`
            : `Restarting this device's agent loop. This connection drops while that happens.`,
    );
    // Fresh watermark per run, taken BEFORE the spawn: the log is append-only and long-lived (every previous
    // run is in it), so a reader must be shown this run's lines and no earlier one's.
    const start = (await readFrom(agentLogPath, 0)).at;
    const pid = await spawnDetached(agentLogPath, machineLauncher(), [AGENT_VERB[op]]);
    onLine(`Started ${AGENT_VERB[op]} (pid ${pid}), detached from this connection so it finishes either way. Log: ${agentLogPath}`);

    let at = start;
    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    let goneAt: number | undefined;
    while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a tail is serial by definition: read, emit, wait
        const { text, at: next } = await readFrom(agentLogPath, at);
        at = next;
        for (const line of text.split(/\r?\n/).filter((one) => one.trim() !== "")) {
            onLine(line);
        }
        if (!isProcessAlive(pid)) {
            goneAt ??= Date.now();
            if (Date.now() - goneAt > DRAIN_MS) {
                break;
            }
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(POLL_MS);
    }
    return op === "upgrade"
        ? `The update ran on this device. Whether the new agent is the one serving shows in its version, which this view re-reads on its own.`
        : `The agent loop was restarted on this device.`;
};
