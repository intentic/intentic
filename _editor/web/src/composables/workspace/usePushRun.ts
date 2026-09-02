import type { PushRun } from "@intentic/sandbox-contract";
import { jsonBody } from "../sandbox/jsonBody";
import { sandboxJsonVia } from "../sandbox/sandboxClient";
import { createRunWatcher, type RunWatcher } from "./runWatcher";

/* THE PUSH, browser-side: the same watcher the pre-push check rides (runWatcher.ts), over the daemon's push
 * verbs, one per repository, because a workspace pushes several and each has its own verdict to poll for.
 *
 * WHY THE PUSH IS A RUN AT ALL. It runs the repository's own pre-push hook, which in a workspace with a real
 * gate is the whole suite: minutes, and output the owner needs to read. Sent as one request it was a request
 * that died at the browser's header deadline while git was still working, reported as "your sandbox didn't
 * answer" over a push that then went, and left the hook's words in nobody's hands. As a run it starts at
 * once, shows itself in the same terminal as the check, and settles with git's last word and who said it.
 *
 * `at` names another sandbox, for the ledger of work stranded on other machines (changesAcross.ts), which
 * pushes a row there without switching; `undefined` is the box the user is standing in. Watchers are kept per
 * box-and-repo so a row's second press joins the run its first one started. */

const watchers = new Map<string, RunWatcher<PushRun>>();

export const usePushRun = (repo: string, at?: string): RunWatcher<PushRun> => {
    const key = `${at ?? ``}:${repo}`;
    const existing = watchers.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const path = `/git/${encodeURIComponent(repo)}/push`;
    const watcher = createRunWatcher<PushRun>({
        idle: { status: `idle`, repo, command: ``, output: `` },
        start: () => sandboxJsonVia(at, path, jsonBody(`POST`, {})),
        state: () => sandboxJsonVia<PushRun>(at, path),
        cancel: () => sandboxJsonVia(at, `${path}/cancel`, { method: `POST` }),
        // The terminals panel shows the ACTIVE sandbox's sessions, so a push running on another box has no
        // panel here to open: its row reports the verdict, and the terminal is one switch away on that box.
        reveal: at === undefined ? (run) => ({ title: `Pushing ${repo}`, detail: run.command }) : () => undefined,
        subject: `push`,
    });
    watchers.set(key, watcher);
    return watcher;
};

// Everything held about pushes in flight, dropped when the browser is pointed at another workspace
// (sandboxScope): a run being polled there is about repositories the reader is no longer in.
export const resetPushRuns = (): void => {
    for (const watcher of watchers.values()) {
        watcher.forget();
    }
    watchers.clear();
};
