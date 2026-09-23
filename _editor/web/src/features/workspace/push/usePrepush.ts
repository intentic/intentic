import { sandboxShallowRef } from "@intentic/extension-api";
import type { CommandRun } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { createRunWatcher, type RunWatcher } from "./runWatcher";
import { t } from "@intentic/ui/i18n";

/* Browser-side pre-push checks run through the shared watcher. */

const IDLE: CommandRun = { status: `idle`, command: ``, output: `` };

// The repositories going out travel with the start: what stands before a push is not the same for every repository,
// since a repository's own declared checks and a rule aimed at one only run when that repository is in the push. One
// watcher per sandbox: a switch drops the run from view, since its terminal is a window in the /work being left.
const watcher = sandboxShallowRef<RunWatcher<CommandRun, readonly string[]>>(
    () =>
        createRunWatcher<CommandRun, readonly string[]>({
            idle: IDLE,
            start: (repos) => sandboxRpc.prepush.run({ repos: [...repos] }),
            state: () => sandboxRpc.prepush.state(),
            cancel: () => sandboxRpc.prepush.cancel(),
            reveal: (run) => ({ title: t(`workspace.usePrepush.runningPrePushCheck`), detail: run.command }),
            subject: `checks`,
        }),
    (previous) => previous.forget(),
);

export function usePrepush(): RunWatcher<CommandRun, readonly string[]> {
    return watcher.value;
}
