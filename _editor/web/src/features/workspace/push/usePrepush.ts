import type { CommandRun } from "@intentic/sandbox-contract";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { createRunWatcher, type RunWatcher } from "./runWatcher";

/* Browser-side pre-push checks run through the shared watcher. */

const IDLE: CommandRun = { status: `idle`, command: ``, output: `` };

// The repositories going out travel with the start: what stands before a push is not the same for every repository,
// since a repository's own declared checks and a rule aimed at one only run when that repository is in the push.
const watcher: RunWatcher<CommandRun, readonly string[]> = createRunWatcher<CommandRun, readonly string[]>({
    idle: IDLE,
    start: (repos) => sandboxJson(`/prepush/run`, jsonBody(`POST`, { repos })),
    state: () => sandboxJson<CommandRun>(`/prepush/state`),
    cancel: () => sandboxJson(`/prepush/cancel`, { method: `POST` }),
    reveal: (run) => ({ title: `Running your pre-push check`, detail: run.command }),
    subject: `checks`,
});

export function usePrepush(): RunWatcher<CommandRun, readonly string[]> {
    return watcher;
}
