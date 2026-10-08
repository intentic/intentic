import { sandboxRef } from "@intentic/extension-api";
import type { RepoTarget } from "@intentic/sandbox-contract";
import type { TooltipValue } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import { ahead, behind, syncable, unpublished } from "../../push/outgoingWork";
import { usePushFlow } from "../../push/usePushFlow";
import { discardTargets, fileRows, type ChangedFile } from "./changedFiles";
import { truncatedTotal } from "../truncation";
import { useChanges } from "../useChanges";

// What a maker can do to the tree — name and save it, throw some of it away, back it up — and the one question
// throwing away raises. State lives at module level, per sandbox: the name being typed outlives a trip to the Files tab,
// as the developer's commit message does (commitMessage.ts).

/** One heading's files, thrown away together; `who` names them in the card that asks. */
export interface ChangeBatch {
    readonly who: string;
    readonly files: readonly ChangedFile[];
}

/** What a press is asking about: one file, one heading's files, or `all` of the tree; undefined when nothing is. */
const asked = sandboxRef<ChangedFile | ChangeBatch | "all" | undefined>(() => undefined);

/** The name the maker typed for the next version; empty means the suggested one (savedMessage.ts). */
const versionName = sandboxRef<string>(() => ``);

const isBatch = (target: ChangedFile | ChangeBatch): target is ChangeBatch => `files` in target;

export function useSaveActions() {
    const t = useT();
    const changes = useChanges();
    const words = useVocabulary();
    const pushFlow = usePushFlow();

    // Repos git could read; the rest are listed with their reason and no actions, as in the developer's panel.
    const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
    // Every repository with something in it, whole: a save is never partial, which is what lets this panel have no
    // index. A clean repository is in the list for its remote alone, and a commit there would spend a round trip on
    // nothing.
    const dirtyRepos = computed<readonly RepoTarget[]>(() =>
        scannable.value.filter((repo) => fileRows(repo).length > 0 || truncatedTotal(repo) > 0).map((repo) => ({ repo: repo.repo })),
    );
    // The daemon caps rows at 500 a repository; both the list and the cards below say what they left out rather than
    // quietly covering less than the press does.
    const notListed = computed(() => scannable.value.reduce((total, repo) => total + truncatedTotal(repo), 0));

    // THROWING WORK AWAY. One pending ask at a time, spelled out before it runs; restore points are the net under it.

    const ask = (what: ChangedFile | ChangeBatch | "all"): void => {
        asked.value = what;
    };
    const dismiss = (): void => {
        asked.value = undefined;
    };

    // A card, not a strip under the button: the press that raises this can be a row 700px above the panel's floor, and
    // a destructive question the reader scrolls past is not a question. Resolved once so the card and the run agree.
    const discardAsk = computed(() => {
        const target = asked.value;
        if (target === undefined) {
            return undefined;
        }
        const files = target === `all` ? scannable.value.flatMap((repo) => [...fileRows(repo)]) : isBatch(target) ? target.files : [target];
        // A file no version holds has no copy anywhere; undoing it deletes it rather than rewinding it.
        const gone = files.filter((file) => file.status === `added`);
        return {
            what:
                target === `all`
                    ? t(`workspace.savePanel.allChanges`, { count: changes.count.value }, changes.count.value)
                    : isBatch(target)
                      ? t(`workspace.savePanel.changesFrom`, { count: files.length, who: target.who }, files.length)
                      : target.label,
            gone: gone.map((file) => file.label),
            back: files.length - gone.length,
            // The counts are a floor while the daemon truncated the list; the act still covers everything.
            partial: target === `all` && notListed.value > 0,
        };
    });

    const runDiscard = async (): Promise<void> => {
        const target = asked.value;
        asked.value = undefined;
        if (target === undefined) {
            return;
        }
        // An empty target is the whole repository; a named one is every leg of every file it names.
        await changes.discardGroups(target === `all` ? dirtyRepos.value : discardTargets(isBatch(target) ? target.files : [target]));
    };

    // BACKING UP, for the maker who cloned their project from somewhere. One button for git's four verbs, since the
    // difference between push, publish and sync is not a distinction a maker has been offered.

    const backupRepos = computed(() =>
        scannable.value.filter((repo) => syncable(repo) && (ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo))),
    );
    const backupCommits = computed(() => backupRepos.value.reduce((total, repo) => total + ahead(repo), 0));
    /** What the backup press is for, on the hover that stands in for the label an icon hasn't got: how much is waiting. */
    const backupTip = computed<TooltipValue>(() => {
        if (pushFlow.running.value) {
            return t(`workspace.savePanel.backingUp`);
        }
        if (backupRepos.value.length === 0) {
            return undefined;
        }
        return backupCommits.value === 0
            ? { title: words.value.push, note: t(`workspace.savePanel.notBackedUpYet`) }
            : { title: words.value.push, rows: [{ label: t(`workspace.savePanel.notBackedUp`), value: backupCommits.value }] };
    });
    // Through askSync, like every other door to a push: a second one would leave a hook's refusal unasked.
    const doBackUp = (): void =>
        pushFlow.askSync(
            words.value.push,
            backupCommits.value > 0
                ? t(`workspace.savePanel.versionCount`, { count: backupCommits.value }, backupCommits.value)
                : words.value.thisRepo,
            backupRepos.value.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: ahead(repo) > 0 || unpublished(repo) })),
        );

    return {
        versionName,
        dirtyRepos,
        notListed,
        ask,
        dismiss,
        discardAsk,
        runDiscard,
        backupRepos,
        backupTip,
        backupCommits,
        backingUp: pushFlow.running,
        doBackUp,
    };
}
