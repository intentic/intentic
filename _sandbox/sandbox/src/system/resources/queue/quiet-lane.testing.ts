import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// Real bin/queue-run commands for a test to fill a quiet lane with (quiet-lane.ts). Not part of the build.

const QUEUE_RUN = join(packageRoot(import.meta.url), "bin", "queue-run");
const RENDEZVOUS_MS = 30_000;

export const QUIET_RUN = ["--pool", "quiet", "--limit", "1", "--label", "quiet", "--exclusive"] as const;

// What queue-run says the moment a command starts waiting at the gate.
export const AT_THE_TURNSTILE = "waiting: a command that must run with nothing else heavy beside it";

/** Starts queue-run as `owner`'s and resolves once its own words show it reached `said`; rejects if it never does. */
export const startQueueRun = (queue: string, owner: string, args: readonly string[], command: string, said: string): Promise<ChildProcess> =>
    new Promise((resolve, reject) => {
        const child = spawn("bash", [QUEUE_RUN, ...args, "--", "bash", "-c", command], {
            env: {
                ...process.env,
                INTENTIC_QUEUE_DIR: queue,
                INTENTIC_QUEUE_CAPTURE_DIR: "",
                // The suite may itself run under queue-run, whose gate would otherwise pass to every command here.
                INTENTIC_QUEUE_GATE: "",
                INTENTIC_TURN_OWNER: owner,
            },
        });
        let seen = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${owner}'s command never said "${said}", so nothing after it tests what it says`));
        }, RENDEZVOUS_MS);
        const look = (chunk: Buffer): void => {
            seen += chunk.toString();
            if (seen.includes(said)) {
                clearTimeout(timer);
                resolve(child);
            }
        };
        child.stdout.on("data", look);
        child.stderr.on("data", look);
    });
