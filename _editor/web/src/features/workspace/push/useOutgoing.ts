import type { RepoChanges } from "@intentic/sandbox-contract";
import { formatElapsed, timeAgo, type Tip, type TipRow } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useChanges } from "../changes/useChanges";
import { ahead, behind, syncable, unpublished } from "./outgoingWork";
import { usePushFlow } from "./usePushFlow";

// What the Changes dock says about the remote: the one sync every repo needs, the run while it is in flight, and a
// refused push's verdict once its card was closed. One block in three states, never two stacked, so the control that
// was pressed is the one that reports. Read off the same remote state as the rail tile (outgoingWork.ts).

export type SyncVerb = `push` | `pull` | `sync` | `publish`;

export function useOutgoing() {
    const t = useT();
    const changes = useChanges();
    const words = useVocabulary();
    // The push, started here but owned above the panel, so leaving the view doesn't lose the run or its question.
    const pushFlow = usePushFlow();
    // Ticks while a push is in flight, and while a verdict stands unanswered: that line counts up too, and a frozen
    // "4m ago" over a failure from an hour back is worse than no clock at all.
    const now = useNow(() => pushFlow.running.value || pushFlow.held.value !== undefined);

    const scannable = computed(() => changes.repos.value.filter((repo) => repo.error === undefined));
    const syncRepos = computed(() => scannable.value.filter((repo) => syncable(repo) && (ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo))));
    const aheadTotal = computed(() => syncRepos.value.reduce((total, repo) => total + ahead(repo), 0));
    const behindTotal = computed(() => syncRepos.value.reduce((total, repo) => total + behind(repo), 0));
    const toPublish = computed(() => syncRepos.value.some((repo) => unpublished(repo)));

    // Pull for incoming only, Push for outgoing only, Publish for an unpublished branch alone, Sync when a repo carries
    // both. Mixed publish and outgoing reads Push.
    const syncVerb = computed<SyncVerb | undefined>(() => {
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
    // Straight arrows: the diagonal ones read as "open elsewhere". `running` is the word the status line says while the
    // verb is in flight.
    const SYNC_VERB = computed<
        Record<SyncVerb, { readonly label: string; readonly running: string; readonly icon: `arrow-up` | `arrow-down` | `sync` | `cloud-upload` }>
    >(() => ({
        push: { label: words.value.push, running: words.value.pushing, icon: `arrow-up` },
        pull: { label: t(`workspace.reviewPanel.pull`), running: t(`workspace.reviewPanel.pulling`), icon: `arrow-down` },
        sync: { label: words.value.sync, running: words.value.syncing, icon: `sync` },
        publish: { label: words.value.publish, running: words.value.publishing, icon: `cloud-upload` },
    }));
    const syncMeta = computed(() => (syncVerb.value === undefined ? undefined : SYNC_VERB.value[syncVerb.value]));

    // The button says how much it moves, in commits: a bare number beside a list of files read as files. A sync names
    // both directions in the counts beside it instead, and a publish has nothing to count.
    const syncLabel = computed<string>(() => {
        const meta = syncMeta.value;
        if (meta === undefined) {
            return words.value.push;
        }
        const count = syncVerb.value === `push` ? aheadTotal.value : syncVerb.value === `pull` ? behindTotal.value : 0;
        return count > 0 ? t(`workspace.reviewPanel.verbCommits`, { verb: meta.label, count }, count) : meta.label;
    });

    // Repo spread, said only when more than one repo is in play.
    const syncRepoSpread = computed(() =>
        syncRepos.value.length > 1 ? t(`workspace.reviewPanel.repoCount`, { count: syncRepos.value.length }, syncRepos.value.length) : undefined,
    );
    // The readout beside the button when the button can't say it all: both directions for a sync, the missing upstream
    // for a publish, the spread across repos.
    const syncSummary = computed<string | undefined>(() => {
        const parts = [
            ...(syncVerb.value === `sync` && behindTotal.value > 0
                ? [t(`workspace.reviewPanel.toPullCount`, { count: behindTotal.value }, behindTotal.value)]
                : []),
            ...(syncVerb.value === `sync` && aheadTotal.value > 0
                ? [t(`workspace.reviewPanel.toPushCount`, { count: aheadTotal.value }, aheadTotal.value)]
                : []),
            ...(behindTotal.value === 0 && aheadTotal.value === 0 && toPublish.value ? [t(`workspace.reviewPanel.noUpstreamYet`)] : []),
            ...(syncRepoSpread.value === undefined ? [] : [syncRepoSpread.value]),
        ];
        return parts.length === 0 ? undefined : parts.join(` · `);
    });

    // Names which repos, since the label only counts. The replay caveat rides here too: the one thing about this verb
    // a user can be surprised by.
    const syncTip = computed((): Tip => ({
        title: syncMeta.value?.label ?? words.value.sync,
        rows: [
            ...(aheadTotal.value > 0 ? [{ label: t(`workspace.reviewPanel.notPushed`), value: aheadTotal.value }] : []),
            ...(behindTotal.value > 0 ? [{ label: t(`workspace.reviewPanel.toPull`), value: behindTotal.value }] : []),
            whereRow(syncRepos.value),
        ],
        note: behindTotal.value > 0 ? t(`workspace.reviewPanel.rebasesNeverMerges`) : undefined,
    }));
    const whereRow = (counted: readonly RepoChanges[]): TipRow => ({
        label: t(`workspace.reviewPanel.repoLabel`, {}, counted.length),
        value: counted.length === 1 ? counted[0]!.repo : counted.length,
    });

    // What a sync sends, named in "Pushed …" and "Sending … to the remote": the commits (or the branch), and across how
    // many repos. A noun phrase, which each language's sentence around it takes whole.
    const syncWhat = (repos: readonly RepoChanges[]): string => {
        const commits = repos.reduce((total, repo) => total + ahead(repo), 0);
        const what = commits > 0 ? t(`workspace.reviewPanel.commitCount`, { count: commits }, commits) : t(`workspace.reviewPanel.thisBranch`);
        return repos.length > 1 ? t(`workspace.reviewPanel.whatAcrossRepos`, { what, count: repos.length }, repos.length) : what;
    };

    // One click, every repo with remote work (or just `only`, for a commit that pushes itself): git can't span remotes,
    // so this fans out into one real sync per repo, through the one door where a refusal becomes a question.
    const doSync = (only?: readonly string[]): void => {
        const repos = only === undefined ? syncRepos.value : syncRepos.value.filter((repo) => only.includes(repo.repo));
        if (repos.length === 0) {
            return;
        }
        pushFlow.askSync(
            syncMeta.value?.label ?? words.value.sync,
            syncWhat(repos),
            repos.map((repo) => ({ repo: repo.repo, pull: behind(repo) > 0, push: ahead(repo) > 0 || unpublished(repo) })),
        );
    };

    // One line, the width the sidebar can spend on status.
    const stageLine = computed<string | undefined>(() => {
        if (pushFlow.running.value) {
            // The run carries the label it was asked with; the verb that label belongs to says its running word.
            const verb = pushFlow.pending.value?.verb;
            const running = Object.values(SYNC_VERB.value).find((entry) => entry.label === verb)?.running ?? SYNC_VERB.value.push.running;
            return t(`workspace.reviewPanel.runningFor`, { running, elapsed: formatElapsed((now.value - pushFlow.since.value) / 1000) });
        }
        const sent = pushFlow.pushed.value;
        return sent === undefined ? undefined : t(`workspace.reviewPanel.pushedWhat`, { what: sent.what });
    });
    // What is going out, spelled out on a phone, which has no hover.
    const stageHint = computed<string | undefined>(() =>
        pushFlow.running.value
            ? t(`workspace.reviewPanel.sendingWhat`, { what: pushFlow.pending.value?.what ?? t(`workspace.reviewPanel.yourCommits`) })
            : undefined,
    );
    const stageTip = computed((): Tip | undefined =>
        pushFlow.running.value
            ? { title: t(`ui.status.sending`), rows: [{ label: t(`workspace.reviewPanel.toRemote`), value: pushFlow.pending.value?.what ?? `` }] }
            : undefined,
    );
    // Closing a card hides its question but does not change the verdict.
    const heldLine = computed<string | undefined>(() => {
        const held = pushFlow.held.value;
        return held === undefined ? undefined : `${held.question.title} · ${timeAgo(held.at, { now: now.value })}`;
    });
    // What the press shows, and what the button beside it does instead.
    const heldTip = computed((): Tip | undefined => {
        const held = pushFlow.held.value;
        return held === undefined
            ? undefined
            : {
                  title: t(`workspace.reviewPanel.whatHappened`),
                  rows: [{ label: t(`workspace.reviewPanel.command`), value: held.question.command ?? `` }],
                  note: t(`workspace.reviewPanel.retriesWithHooks`, { verb: syncMeta.value?.label ?? words.value.push }),
              };
    });

    const outgoing = computed<`flow` | `held` | `offer` | undefined>(() =>
        stageLine.value !== undefined ? `flow` : heldLine.value !== undefined ? `held` : syncMeta.value !== undefined ? `offer` : undefined,
    );

    return {
        pushFlow,
        now,
        syncRepos,
        aheadTotal,
        behindTotal,
        syncMeta,
        syncLabel,
        syncSummary,
        syncTip,
        doSync,
        stageLine,
        stageHint,
        stageTip,
        heldLine,
        heldTip,
        outgoing,
    };
}
