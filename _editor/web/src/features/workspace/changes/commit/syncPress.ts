import type { RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref } from "vue";
import { ahead, behind, syncable, unpublished } from "../../../../models/workspace/push/outgoingWork";
import { useVocabulary } from "../../../../workbench/views/vocabulary";

// THE SYNC PRESS on the Changes panel's bar (ReviewPanel.vue), read off the listed repos: which verb it offers, how many
// commits go each way, what its face, hover and spoken name say, and the same counts as words for the bar's line when
// Commit is not there beside it.

export const useSyncPress = (scannable: Readonly<Ref<readonly RepoChanges[]>>) => {
    const words = useVocabulary();
    // Shown only for a repo with a remote. `syncable`/`ahead`/`behind`/`unpublished` come from useChanges, so the
    // rail tile and this panel read a repo the same way. No verb reaches a row anymore — see the outgoing block above the
    // list.

    // VSCode's post-commit move: the slot just used to Commit becomes the sync the repos need, once the commit
    // box has nothing left to show. Per-row pills remain the granular control for a set whose repos need different things.
    const syncRepos = computed(() => scannable.value.filter((repo) => syncable(repo) && (ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo))));
    const aheadTotal = computed(() => syncRepos.value.reduce((total, repo) => total + ahead(repo), 0));
    const behindTotal = computed(() => syncRepos.value.reduce((total, repo) => total + behind(repo), 0));
    const toPublish = computed(() => syncRepos.value.some((repo) => unpublished(repo)));
    // Mirrors the row pills so the bar can't contradict them: Pull for incoming-only, Push for outgoing-only,
    // Publish for an unpublished branch alone, Sync when a repo carries both. Mixed publish+outgoing reads Push.
    const syncVerb = computed<"push" | "pull" | "sync" | "publish" | undefined>(() => {
        if (syncRepos.value.length === 0) {
            return undefined;
        }
        if (behindTotal.value > 0) {
            return aheadTotal.value > 0 || toPublish.value ? `sync` : `pull`;
        }
        if (toPublish.value && aheadTotal.value === 0) {
            return `publish`;
        }
        return `push`;
    });
    // Icons match the arrows on the counts the button carries (↑ push, ↓ pull), so the two read as one language. Straight arrows, since the
    // diagonal one means "open elsewhere" across the app.
    // The button's hover (`syncTip`) adds what the label can't: which repos, and the replay caveat when pulling.
    // `running` is the word the status line says while the verb is in flight.
    const SYNC_VERB = computed<
        Record<
            "push" | "pull" | "sync" | "publish",
            { readonly label: string; readonly running: string; readonly icon: "arrow-up" | "arrow-down" | "sync" | "cloud-upload" }
        >
    >(() => ({
        push: { label: words.value.push, running: words.value.pushing, icon: `arrow-up` },
        pull: { label: t(`workspace.reviewPanel.pull`), running: t(`workspace.reviewPanel.pulling`), icon: `arrow-down` },
        sync: { label: words.value.sync, running: words.value.syncing, icon: `sync` },
        publish: { label: words.value.publish, running: words.value.publishing, icon: `cloud-upload` },
    }));
    const syncMeta = computed(() => (syncVerb.value === undefined ? undefined : SYNC_VERB.value[syncVerb.value]));
    // Counts plus the repo spread when more than one is in play; a pure publish has nothing to count.
    const syncSummary = computed<string>(() => {
        const counts = [...(behindTotal.value > 0 ? [`↓${behindTotal.value}`] : []), ...(aheadTotal.value > 0 ? [`↑${aheadTotal.value}`] : [])];
        const spread = syncRepos.value.length > 1 ? t(`workspace.reviewPanel.repos`, { count: syncRepos.value.length }, syncRepos.value.length) : ``;
        return (counts.length > 0 ? counts.join(` `) : t(`workspace.reviewPanel.noUpstreamYet`)) + spread;
    });
    // The same counts in words, for the bar's line when Commit isn't there to sit beside the press: incoming first, as the
    // press's own arrows read. Both ways at once drop the word "commits", which the sidebar has no room to say twice. A
    // pure publish counts branches, since there is no commit to count.
    const outgoingWords = computed<string | undefined>(() => {
        const [pull, push] = [behindTotal.value, aheadTotal.value];
        if (pull > 0 && push > 0) {
            return t(`workspace.reviewPanel.pullAndPush`, { pull, push });
        }
        const branches = syncRepos.value.filter((repo) => unpublished(repo)).length;
        const parts = [
            ...(pull > 0 ? [t(`workspace.reviewPanel.commitsToPull`, { count: pull }, pull)] : []),
            ...(push > 0
                ? [t(`workspace.outgoingWork.toPush`, { count: push }, push)]
                : branches > 0
                  ? [t(`workspace.outgoingWork.unpushedBranch`, { count: branches }, branches)]
                  : []),
        ];
        return parts.length === 0 ? undefined : parts.join(` · `);
    });
    // The button carries the bare count, as Commit does; its hover says which way each number goes and which repos it
    // spans. The replay caveat rides here too — the one thing about this verb a user can be surprised by.
    const syncTip = computed((): Tip => ({
        title: syncMeta.value?.label ?? words.value.sync,
        rows: [
            ...(aheadTotal.value > 0 ? [{ label: t(`workspace.reviewPanel.notPushed`), value: aheadTotal.value }] : []),
            ...(behindTotal.value > 0 ? [{ label: t(`workspace.reviewPanel.toPull`), value: behindTotal.value }] : []),
            {
                label: t(`workspace.reviewPanel.repoLabel`, {}, syncRepos.value.length),
                value: syncRepos.value.map((repo) => repo.repo).join(`, `),
            },
        ],
        note: behindTotal.value > 0 ? t(`workspace.reviewPanel.rebasesNeverMerges`) : undefined,
    }));
    return { syncRepos, aheadTotal, behindTotal, syncVerb, SYNC_VERB, syncMeta, syncSummary, outgoingWords, syncTip };
};
