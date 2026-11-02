import { useQueryClient } from "@tanstack/vue-query";
import { useNow,formatElapsed } from "@intentic/ui";
import type { NoticeModel } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, hasInjectionContext, onScopeDispose, ref } from "vue";
import { useRouter } from "vue-router";
import { setProjectScope } from "../../../app/projectScope";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { rpcPrefix, workingReviewKeys } from "../../../lib/queryKeys";
import { hold, useNotifications } from "../../../workbench/notifications/notifications";
import { dismissOperation, type Operation, operationsUnder, useOperations } from "../../../workbench/operations/operations";
import { repoNameFromUrl } from "../health/repoName";
import { useBringProject } from "./useBringProject";

// Clones a repository into the workspace, landing at /work/<name> derived from the URL. The daemon reserves some names
// and validates the rest, so its verdict is what counts; nothing is pre-validated here beyond having a name to send.

// BACKGROUND WORK, NOT A SCREEN. The daemon runs `git clone` to the end in one request, which can take minutes, so the
// press files the clone in the ledger and lets the dialog go: the notification lane says it is running and how long it
// has been, a receipt says when it landed (with a way to open it), and a failure waits on the lane with a way back to
// the address. One run per repository name, so a second clone can start while the first is still going.
export const ADD_REPO = `workspace/add-repo`;

// What the run carries from its press: the address, said on the lane while it runs and put back in the field after a
// failure, to correct rather than retype.
interface AddRepoProgress {
    readonly url: string;
}

type CloneRun = Operation<void, NoticeModel, AddRepoProgress>;

// How many address forms are on screen. A failure is said in the form while one is, and on the lane only while none is.
const formsShown = ref(0);

const failedRuns = (runs: readonly CloneRun[]): readonly CloneRun[] => runs.filter((run) => run.state === `failed`);

export function useAddRepo() {
    const queryClient = useQueryClient();
    // A form's own composable, so the receipt can take the reader to what landed; absent in a bare test scope.
    const router = hasInjectionContext() ? useRouter() : undefined;
    const { report } = useNotifications();
    const clones = useOperations<void, NoticeModel, AddRepoProgress>(ADD_REPO);
    // An address with nothing to clone, or one already cloning, is refused here before anything is sent.
    const refused = ref<NoticeModel | undefined>(undefined);
    formsShown.value += 1;
    onScopeDispose(() => {
        formsShown.value -= 1;
    });

    // The newest clone that failed and has not been put away: the one the form answers.
    const failed = computed(() => failedRuns(clones.all.value).at(-1));

    const open = (name: string): void => {
        setProjectScope(name);
        void router?.push({ name: `workspace` });
    };

    // Files the clone and answers at once whether it was taken: the caller clears its field and closes, and the lane
    // carries the rest. Everything a new repository changes (file tree, panels, repos, the changes scan) is refetched
    // before the run counts as done, so the receipt never points at a folder the tree has not drawn yet.
    const addRepo = (cloneUrl: string): boolean => {
        const url = cloneUrl.trim();
        const name = repoNameFromUrl(url);
        if (url.length === 0 || name.length === 0) {
            refused.value = { tone: `danger`, title: t(`workspace.useAddRepo.cloneFailed`), detail: t(`workspace.useAddRepo.notAnAddress`) };
            return false;
        }
        // The daemon's answer to a second press was a misleading "already exists".
        if (clones.at(name)?.state === `running`) {
            refused.value = { tone: `info`, title: t(`workspace.useAddRepo.alreadyCloning`, { name }) };
            return false;
        }
        refused.value = undefined;
        // A new press is the answer to the failures before it.
        for (const run of failedRuns(clones.all.value)) {
            dismissOperation(run.key);
        }
        void clones
            .run(name, {
                what: t(`workspace.useAddRepo.cloning`, { name }),
                // The daemon's own message rides as the detail: it knows whether it's a reserved name, an unreachable
                // host, or missing credentials.
                failed: t(`workspace.useAddRepo.cloneFailed`),
                progress: { url },
                // The lane already followed it; the receipt below is raised here, with a way to open what landed.
                quiet: true,
                task: async () => {
                    await sandboxRpc.workspace.addRepo({ name, cloneUrl: url });
                    await Promise.all(
                        [rpcPrefix(`workspace.tree`), rpcPrefix(`panels.list`), rpcPrefix(`git.repos`), ...workingReviewKeys].map((queryKey) =>
                            queryClient.invalidateQueries({ queryKey }),
                        ),
                    );
                },
            })
            .then((outcome) => {
                if (outcome?.state !== `done`) {
                    return;
                }
                dismissOperation(outcome.key);
                report({
                    tone: `done`,
                    title: t(`workspace.useAddRepo.cloned`, { name }),
                    actions: router === undefined ? undefined : [{ label: t(`ui.action.open`), run: () => open(name) }],
                });
            });
        return true;
    };

    return {
        addRepo,
        failure: computed(() => refused.value ?? failed.value?.failure),
        // The address of the newest clone that failed, to put back in the field.
        failedUrl: computed(() => failed.value?.progress?.url),
    };
}

// The address as the lane says it: no scheme, and never the credentials a pasted URL can carry.
export const shownAddress = (url: string): string =>
    url
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, ``)
        .replace(/^[^@/]*@/, ``);

/**
 * The lane's cards for clones, as copying many files has its own: one while any runs (what, from where, how long), and
 * one for the newest failure while no form is on screen to say it, with the way back to its address. Called from a
 * component's setup: the running card's clock is bound to it.
 */
export const holdCloneNotice = (): (() => void) => {
    const runs = computed(() => operationsUnder<void, NoticeModel, AddRepoProgress>(ADD_REPO));
    const running = computed(() => runs.value.filter((run) => run.state === `running`));
    const now = useNow(computed(() => running.value.length > 0));
    const { show } = useBringProject();

    const stopRunning = hold(`clone`, () => {
        const list = running.value;
        const first = list[0];
        if (first === undefined) {
            return undefined;
        }
        const elapsed = formatElapsed((now.value - first.startedAt) / 1000);
        const names = list.map((run) => repoNameFromUrl(run.progress?.url ?? ``));
        return {
            kind: `condition`,
            tone: `info`,
            icon: `spinner`,
            spin: true,
            title:
                list.length === 1
                    ? t(`workspace.useAddRepo.cloning`, { name: names[0] })
                    : t(`workspace.useAddRepo.cloningMany`, { count: list.length }, list.length),
            detail: `${list.length === 1 ? shownAddress(first.progress?.url ?? ``) : names.join(`, `)} · ${elapsed}`,
        };
    });

    const stopFailed = hold(`clone-failed`, () => {
        const run = failedRuns(runs.value).at(-1);
        if (run === undefined || formsShown.value > 0) {
            return undefined;
        }
        return {
            kind: `condition`,
            tone: `problem`,
            title: t(`workspace.useAddRepo.cloneFailedNamed`, { name: repoNameFromUrl(run.progress?.url ?? ``) }),
            detail: run.failure?.detail,
            actions: [{ label: t(`workspace.useAddRepo.editAddress`), tier: `accent` as const, run: show }],
            dismiss: () => dismissOperation(run.key),
        };
    });

    return (): void => {
        stopRunning();
        stopFailed();
    };
};
