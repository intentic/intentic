import { scopeKey, SHARED_SCOPE, type ViewScope } from "../../../app/workspaceScope";
import { sandboxValue } from "@intentic/extension-api";
import type { PushRun } from "@intentic/sandbox-contract/schemas/git/git";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { createRunWatcher, type RunWatcher } from "./runWatcher";
import { t } from "@intentic/ui/i18n";

// The run watcher over the daemon's push verbs, one per repository. A push runs the repo's own pre-push hook, which can
// take minutes, so it's a run, not one request dying at the header deadline. Watchers are kept per repo and view, joining
// a second press to the run already started.

// Dropped with the sandbox: a run being polled there is about repos the reader has left.
const watchers = sandboxValue(
    () => new Map<string, RunWatcher<PushRun>>(),
    (previous) => previous.forEach((watcher) => watcher.forget()),
);

export const usePushRun = (repo: string, view: ViewScope = SHARED_SCOPE): RunWatcher<PushRun> => {
    const key = `${repo}:${scopeKey(view)}`;
    const existing = watchers.value.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const options = { context: { gitView: view } };
    const watcher = createRunWatcher<PushRun>({
        idle: { status: `idle`, repo, command: ``, output: `` },
        start: () => sandboxRpc.git.push({ repo }, options),
        state: () => sandboxRpc.git.pushState({ repo }, options),
        cancel: () => sandboxRpc.git.pushCancel({ repo }, options),
        reveal: (run) => ({ title: t(`workspace.usePushRun.pushing`, { repo }), detail: run.command }),
        says: {
            startFailed: () => t(`workspace.usePushRun.startFailed`),
            lostContact: () => t(`workspace.usePushRun.lostContact`),
            stopFailed: () => t(`workspace.usePushRun.stopFailed`),
        },
    });
    watchers.value.set(key, watcher);
    return watcher;
};
