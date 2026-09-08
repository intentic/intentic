import type { PushRun } from "@intentic/sandbox-contract";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJsonVia } from "../../sandbox/client/sandboxClient";
import { createRunWatcher, type RunWatcher } from "./runWatcher";

// Same watcher the pre-push check rides, over the daemon's push verbs, one per repository. A push runs the
// repo's own hook, which can take minutes, so it's a run, not one request dying at the header deadline. `at`
// names another sandbox for the cross-box ledger; watchers are kept per box-and-repo, joining a second press to the run
// already started.

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
        // The terminal panel shows only the active sandbox's sessions, so a push on another box has no panel to open
        // here; its row reports the verdict instead.
        reveal: at === undefined ? (run) => ({ title: `Pushing ${repo}`, detail: run.command }) : () => undefined,
        subject: `push`,
    });
    watchers.set(key, watcher);
    return watcher;
};

// Everything held about pushes in flight, dropped on a sandbox switch (sandboxScope): a run being polled
// there is about repos the reader has left.
export const resetPushRuns = (): void => {
    for (const watcher of watchers.values()) {
        watcher.forget();
    }
    watchers.clear();
};
