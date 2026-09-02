import type { CommandRun } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/sandboxClient";
import { createRunWatcher, type RunWatcher } from "./runWatcher";

/* THE PRE-PUSH CHECK, browser-side: the run watcher (runWatcher.ts, which owns the cadence, the reveal and the
 * settle) over the daemon's three prepush verbs. Module scope, because there is one check and one push flow at
 * a time, so a re-render of any surface never restarts a run.
 *
 * The session is called `job-checks` inside the sandbox, and a panel waiting on a tab could only offer that
 * name back, which is not an answer to "why has this opened" for anyone who met it mid-push: the reveal says
 * what is starting instead. */

const IDLE: CommandRun = { status: `idle`, command: ``, output: `` };

const watcher: RunWatcher<CommandRun> = createRunWatcher<CommandRun>({
    idle: IDLE,
    start: () => sandboxJson(`/prepush/run`, { method: `POST` }),
    state: () => sandboxJson<CommandRun>(`/prepush/state`),
    cancel: () => sandboxJson(`/prepush/cancel`, { method: `POST` }),
    reveal: (run) => ({ title: `Running your pre-push check`, detail: run.command }),
    subject: `checks`,
});

export function usePrepush(): RunWatcher<CommandRun> {
    return watcher;
}
