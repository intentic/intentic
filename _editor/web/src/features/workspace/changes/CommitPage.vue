<script setup lang="ts">
import type { GitChange, RepoChanges } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { ahead, behind, unpublished } from "../push/outgoingWork";
import CommitComposer from "./CommitComposer.vue";
import RepoHistory from "./RepoHistory.vue";
import ScopeChips from "./ScopeChips.vue";
import { useChanges } from "./useChanges";
import { useCommitScope } from "./useCommitScope";

// The center of the workspace while the Changes list is open on a desktop: what to stage, the message with the room
// to read it, and the press, then each repo's line, git-graph style, with what the commit takes at its top and the
// press that sends it out (RepoHistory.vue). A diff opened from the list covers this page as a tab, and the Commit
// button before the tabs brings it back.

const t = useT();
const changes = useChanges();
const words = useVocabulary();
const { scannable, rowInScope, plan } = useCommitScope();
const now = useNow(() => true, 60_000);

// What the next commit takes from one repo: files, and the lines they add and take away.
const shareOf = (repo: RepoChanges): { files: number; additions: number; deletions: number } => {
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
    return { files: paths.size, additions, deletions };
};

// Each repo with something to commit or to settle with its remote, the ones the press reaches first.
const reached = computed(() => new Set(plan.value.groups.map((group) => group.repo)));
const lines = computed(() => {
    const shown = scannable.value.filter((repo) => reached.value.has(repo.repo) || ahead(repo) > 0 || behind(repo) > 0 || unpublished(repo));
    const ordered = [...shown.filter((repo) => reached.value.has(repo.repo)), ...shown.filter((repo) => !reached.value.has(repo.repo))];
    // The file count rides a repo's top node only when the commit spans several; with one, the button says it.
    const countFiles = reached.value.size > 1;
    return ordered.map((repo) => ({ repo, share: reached.value.has(repo.repo) ? { ...shareOf(repo), countFiles } : undefined }));
});
</script>

<template>
    <div class="min-h-0 flex-1 overflow-y-auto" data-commit-page>
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
            <p v-if="changes.loaded.value && changes.count.value === 0 && lines.length === 0" class="text-sm text-muted">
                {{ t(`workspace.reviewPanel.noUncommittedChanges`) }}
            </p>
            <ScopeChips v-if="changes.count.value > 0" />
            <CommitComposer variant="page" />
            <RepoHistory v-for="line in lines" :key="line.repo.repo" :repo="line.repo" :share="line.share" :now="now" />
            <p class="text-2xs text-subtle">{{ t(`workspace.commitPage.diffsOpenHere`, { changes: words.changes }) }}</p>
        </div>
    </div>
</template>
