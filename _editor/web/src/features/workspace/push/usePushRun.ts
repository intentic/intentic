import { sandboxValue } from "@intentic/extension-api";
import type { PushRun } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { createRunWatcher, type RunWatcher } from "./runWatcher";
import { t } from "@intentic/ui/i18n";

// The run watcher over the daemon's push verbs, one per repository. A push runs the repo's own pre-push hook, which can
// take minutes, so it's a run, not one request dying at the header deadline. `at` names another sandbox for the
// cross-box ledger; watchers are kept per box-and-repo, joining a second press to the run already started.

// Dropped with the sandbox, cross-box ledger rows included: a run being polled there is about repos the reader has left.
const watchers = sandboxValue(
    () => new Map<string, RunWatcher<PushRun>>(),
    (previous) => previous.forEach((watcher) => watcher.forget()),
);

export const usePushRun = (repo: string, at?: string): RunWatcher<PushRun> => {
    const key = `${at ?? ``}:${repo}`;
    const existing = watchers.value.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const options = { context: { at } };
    const watcher = createRunWatcher<PushRun>({
        idle: { status: `idle`, repo, command: ``, output: `` },
        start: () => sandboxRpc.git.push({ repo }, options),
        state: () => sandboxRpc.git.pushState({ repo }, options),
        cancel: () => sandboxRpc.git.pushCancel({ repo }, options),
        // The terminal panel shows only the active sandbox's sessions, so a push on another box has no panel to open
        // here; its row reports the verdict instead.
        reveal: at === undefined ? (run) => ({ title: t(`workspace.usePushRun.pushing`, { repo }), detail: run.command }) : () => undefined,
        subject: `push`,
    });
    watchers.value.set(key, watcher);
    return watcher;
};
