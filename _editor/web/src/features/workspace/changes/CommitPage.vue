<script setup lang="ts">
import type { GitChange, RepoChanges } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { ahead } from "../push/outgoingWork";
import CommitComposer from "./CommitComposer.vue";
import RecentCommits from "./RecentCommits.vue";
import ScopeChips from "./ScopeChips.vue";
import { useChanges } from "./useChanges";
import { useCommitScope } from "./useCommitScope";

// The center of the workspace while the Changes list is open on a desktop: what to commit, the message with the room
// to read it, and the press, with what goes in and what came before it under them. The list beside it dims what the
// commit leaves out; a diff opened from it covers this page as a tab, and the home button brings it back.

const t = useT();
const changes = useChanges();
const words = useVocabulary();
const { scannable, rowInScope, plan } = useCommitScope();
const now = useNow(() => true, 60_000);

// The repos the press reaches, each with how much of it goes in: files, and the lines they add and take away.
interface RepoShare {
    readonly repo: string;
    readonly branch: string | undefined;
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
}
const shareOf = (repo: RepoChanges): RepoShare => {
    const paths = new Set<string>();
    let additions = 0;
    let deletions = 0;
    const add = (side: `staged` | `unstaged`, change: GitChange): void => {
        if (!rowInScope(repo, side, change.path)) {
            return;
        }
        paths.add(change.path);
        additions += change.additions ?? 0;
        deletions += change.deletions ?? 0;
    };
    for (const change of repo.staged) {
        add(`staged`, change);
    }
    for (const change of repo.unstaged) {
        add(`unstaged`, change);
    }
    return { repo: repo.repo, branch: repo.branch, files: paths.size, additions, deletions };
};
const goesIn = computed<readonly RepoShare[]>(() => {
    const reached = new Set(plan.value.groups.map((group) => group.repo));
    return scannable.value.filter((repo) => reached.has(repo.repo)).map(shareOf);
});

// Whose history to show: the repos the press reaches, else every repo with something to commit or send.
const historyRepos = computed<readonly string[]>(() => {
    const reached = goesIn.value.map((share) => share.repo);
    if (reached.length > 0) {
        return reached.slice(0, 3);
    }
    return scannable.value
        .filter((repo) => repo.staged.length + repo.unstaged.length > 0 || ahead(repo) > 0)
        .map((repo) => repo.repo)
        .slice(0, 3);
});

// The heading names where this lands: one repo by name and branch, several by count.
const heading = computed(() => {
    const repos = goesIn.value;
    if (repos.length === 1) {
        return { title: t(`workspace.commitPage.commitTo`, { repo: repos[0]!.repo }), branch: repos[0]!.branch };
    }
    return repos.length > 1
        ? { title: t(`workspace.commitPage.commitToRepos`, { count: repos.length }, repos.length), branch: undefined }
        : { title: t(`workspace.commitPage.commit`), branch: undefined };
});
const toSend = computed(() => scannable.value.reduce((total, repo) => total + ahead(repo), 0));
</script>

<template>
    <div class="min-h-0 flex-1 overflow-y-auto" data-commit-page>
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
            <header class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h2 class="min-w-0 truncate text-base font-semibold text-content">{{ heading.title }}</h2>
                <span v-if="heading.branch" class="flex items-center gap-1 text-xs text-subtle">
                    <Icon name="fork" class="text-2xs" />{{ heading.branch }}
                </span>
                <span v-if="toSend > 0" class="text-xs text-subtle">· {{ t(`workspace.reviewPanel.toPushCount`, { count: toSend }, toSend) }}</span>
            </header>

            <p v-if="changes.loaded.value && changes.count.value === 0" class="text-sm text-muted">
                {{ t(`workspace.reviewPanel.noUncommittedChanges`) }}
            </p>
            <ScopeChips v-if="changes.count.value > 0" />
            <CommitComposer variant="page" />

            <section v-if="goesIn.length > 0" class="flex flex-col gap-1">
                <h3 class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`workspace.commitPage.goesIn`) }}</h3>
                <div v-for="share in goesIn" :key="share.repo" class="flex min-w-0 items-baseline gap-2 text-xs" data-goes-in>
                    <span class="min-w-0 truncate font-medium text-content">{{ share.repo }}</span>
                    <span class="shrink-0 text-muted">{{ t(`workspace.reviewPanel.fileCount`, { count: share.files }, share.files) }}</span>
                    <span class="shrink-0 font-mono text-2xs text-success">+{{ share.additions }}</span>
                    <span class="shrink-0 font-mono text-2xs text-danger">−{{ share.deletions }}</span>
                </div>
            </section>

            <!-- Drawn only once some repo has history to show (each RecentCommits renders nothing until then). -->
            <section v-if="historyRepos.length > 0" class="hidden flex-col gap-1 has-[[data-recent-commits]]:flex">
                <h3 class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`workspace.commitPage.lastCommits`) }}</h3>
                <RecentCommits v-for="repo in historyRepos" :key="repo" :repo="repo" :named="historyRepos.length > 1" :now="now" />
            </section>
            <p class="text-2xs text-subtle">{{ t(`workspace.commitPage.diffsOpenHere`, { changes: words.changes }) }}</p>
        </div>
    </div>
</template>
