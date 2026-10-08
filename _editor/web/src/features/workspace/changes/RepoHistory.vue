<script setup lang="ts">
import type { GitCommit, RepoChanges } from "@intentic/sandbox-contract";
import { Button, timeAgo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { ahead, behind, syncable, unpublished } from "../push/outgoingWork";
import { useOutgoing } from "../push/useOutgoing";
import { useChanges } from "./useChanges";
import { useCommitReceipt } from "./useCommitReceipt";

// One repo's line on the commit page, git-graph style: what the next commit takes (when it reaches this repo), the
// commits only this disk has, the press that sends them, where the remote stands, and a few before it, fading. Each
// thing is said once, here: the page's heading, the push button and the receipt all live in this one column.

const { repo, share, now } = defineProps<{
    repo: RepoChanges;
    // What the next commit takes from this repo; absent when it reaches none of it.
    share: { readonly files: number; readonly additions: number; readonly deletions: number; readonly countFiles: boolean } | undefined;
    now: number;
}>();

const t = useT();
const words = useVocabulary();
const changes = useChanges();
const outgoing = useOutgoing();
const { receipt, receiptUndoable, undoReceipt } = useCommitReceipt();

// Enough to reach past what's only here, plus a few the remote already holds.
const PUSHED_SHOWN = 4;
const limit = computed(() => Math.min(ahead(repo) + PUSHED_SHOWN, 24));
const { query } = useSandboxQuery({ ...rpcQuery(`git.log`, () => ({ repo: repo.repo, limit: limit.value, line: true })) });
const commits = computed<readonly GitCommit[]>(() => query.data.value?.commits ?? []);

const remoteName = computed(() => repo.remote?.remote);
const upstream = computed(() => repo.remote?.upstream);
// How many of the newest commits only this disk has: git's own count against the upstream, or, for a branch never
// published, everything above the first commit a remote branch carries.
const localCount = computed(() => {
    if (!syncable(repo)) {
        return 0;
    }
    if (!unpublished(repo)) {
        return ahead(repo);
    }
    const prefix = `${remoteName.value}/`;
    const reached = commits.value.findIndex((commit) => commit.refs.some((ref) => ref.startsWith(prefix)));
    return reached === -1 ? commits.value.length : reached;
});

// The press that settles this repo with its remote, said with where it goes: Push, Pull, Sync, or Publish.
const sendVerb = computed<`push` | `pull` | `sync` | `publish` | undefined>(() => {
    if (!syncable(repo)) {
        return undefined;
    }
    if (behind(repo) > 0) {
        return ahead(repo) > 0 || unpublished(repo) ? `sync` : `pull`;
    }
    if (unpublished(repo)) {
        return `publish`;
    }
    return ahead(repo) > 0 ? `push` : undefined;
});
const SEND_ICON = { push: `arrow-up`, pull: `arrow-down`, sync: `sync`, publish: `cloud-upload` } as const;
const sendLabel = computed(() => {
    const verb = sendVerb.value;
    if (verb === undefined) {
        return ``;
    }
    const action = { push: words.value.push, pull: t(`workspace.reviewPanel.pull`), sync: words.value.sync, publish: words.value.publish }[verb];
    const count = verb === `push` ? ahead(repo) : verb === `pull` ? behind(repo) : 0;
    const what = count > 0 ? t(`workspace.reviewPanel.verbCommits`, { verb: action, count }, count) : action;
    const target = upstream.value ?? remoteName.value;
    return target === undefined ? what : t(`workspace.commitPage.verbTo`, { action: what, target });
});

// The last commit this tab recorded here, which carries the way back while no remote holds it.
const undoableSha = computed(() => (receiptUndoable.value ? receipt.value?.commits.find((commit) => commit.repo === repo.repo)?.sha : undefined));

// The column top to bottom. `local` paints the line and dot in the link colour: work only this disk has.
type Node =
    | { readonly kind: `next` }
    | { readonly kind: `commit`; readonly commit: GitCommit; readonly local: boolean; readonly age: number }
    | { readonly kind: `send` };
const nodes = computed<readonly Node[]>(() => {
    const list: Node[] = share !== undefined && share.files > 0 ? [{ kind: `next` }] : [];
    commits.value.forEach((commit, index) => {
        if (index === localCount.value && sendVerb.value !== undefined) {
            list.push({ kind: `send` });
        }
        list.push({ kind: `commit`, commit, local: index < localCount.value, age: Math.max(0, index - localCount.value) });
    });
    if (sendVerb.value !== undefined && localCount.value >= commits.value.length) {
        list.push({ kind: `send` });
    }
    return list;
});
const localAt = (index: number): boolean => {
    const node = nodes.value[index];
    return node?.kind === `commit` && node.local;
};
// The line above a node is local when it joins two local nodes, or runs from the last local one into the press.
const lineAbove = (index: number): string | undefined => {
    if (index === 0) {
        return undefined;
    }
    return localAt(index - 1) && (localAt(index) || nodes.value[index]?.kind === `send`) ? `bg-link` : `bg-subtle/50`;
};
const lineBelow = (index: number): string | undefined => {
    if (index === nodes.value.length - 1) {
        return query.data.value?.hasMore === true ? `bg-subtle/50` : undefined;
    }
    return lineAbove(index + 1);
};
// Older commits fade, so the eye stops where the news does.
const FADES = [``, `opacity-80`, `opacity-60`, `opacity-45`];
const fade = (age: number): string => FADES[Math.min(age, FADES.length - 1)]!;
// The upstream's own name on the commit it points at, where the remote stands.
const upstreamOn = (commit: GitCommit): string | undefined =>
    upstream.value !== undefined && commit.refs.includes(upstream.value) ? upstream.value : undefined;
</script>

<template>
    <section class="flex min-w-0 flex-col" data-repo-history>
        <h3 class="mb-1 flex min-w-0 items-center gap-1.5 text-xs">
            <span class="truncate font-semibold text-content">{{ repo.repo }}</span>
            <span v-if="repo.branch" class="flex shrink-0 items-center gap-1 text-subtle"
                ><Icon name="fork" class="text-3xs" />{{ repo.branch }}</span
            >
        </h3>
        <ol class="flex min-w-0 flex-col">
            <li v-for="(node, index) in nodes" :key="node.kind === `commit` ? node.commit.sha : node.kind" class="flex min-w-0 items-stretch gap-2.5">
                <!-- The gutter: the line in two halves around the dot, so its colour can change at any node. -->
                <span class="relative w-3 shrink-0" aria-hidden="true">
                    <span v-if="lineAbove(index)" class="absolute top-0 left-[5px] h-1/2 w-0.5" :class="lineAbove(index)"></span>
                    <span v-if="lineBelow(index)" class="absolute bottom-0 left-[5px] h-1/2 w-0.5" :class="lineBelow(index)"></span>
                    <span
                        v-if="node.kind === `next`"
                        class="absolute top-1/2 left-0 size-3 -translate-y-1/2 rounded-full border-2 border-dashed border-subtle bg-canvas"
                    ></span>
                    <span
                        v-else-if="node.kind === `commit`"
                        class="absolute top-1/2 left-[1px] size-2.5 -translate-y-1/2 rounded-full ring-2 ring-canvas"
                        :class="node.local ? `bg-link` : `bg-subtle ${fade(node.age)}`"
                    ></span>
                </span>

                <div v-if="node.kind === `next`" class="flex min-w-0 items-baseline gap-2 py-1 text-xs" data-history-next>
                    <span class="font-medium text-content">{{ t(`workspace.commitPage.uncommitted`) }}</span>
                    <span v-if="share!.countFiles" class="text-muted">{{
                        t(`workspace.reviewPanel.fileCount`, { count: share!.files }, share!.files)
                    }}</span>
                    <span class="font-mono text-2xs text-success">+{{ share!.additions }}</span>
                    <span class="font-mono text-2xs text-danger">−{{ share!.deletions }}</span>
                </div>

                <div v-else-if="node.kind === `send`" class="py-1.5">
                    <Button
                        size="small"
                        severity="secondary"
                        class="whitespace-nowrap"
                        :disabled="changes.actionBusy.value || outgoing.pushFlow.running.value"
                        @click="outgoing.doSync([repo.repo])"
                        data-sync
                    >
                        <Icon :name="SEND_ICON[sendVerb!]" />{{ sendLabel }}
                    </Button>
                </div>

                <div
                    v-else
                    class="flex min-w-0 flex-1 items-baseline gap-2 py-1 text-xs"
                    :class="node.local ? `` : fade(node.age)"
                    v-tooltip.top="{ title: node.commit.subject, rows: [{ label: node.commit.short, value: node.commit.author }] }"
                    data-history-commit
                >
                    <span v-if="upstreamOn(node.commit)" class="shrink-0 rounded border border-line px-1 text-2xs text-muted">{{
                        upstreamOn(node.commit)
                    }}</span>
                    <span class="min-w-0 truncate" :class="node.local ? `text-content` : `text-muted`">{{ node.commit.subject }}</span>
                    <button
                        v-if="node.commit.sha === undoableSha"
                        type="button"
                        :class="ui.textAction(`shrink-0 text-2xs text-link hover:underline`)"
                        :disabled="changes.actionBusy.value"
                        v-tooltip.top="{ title: t(`workspace.reviewPanel.undoCommit`), note: t(`workspace.reviewPanel.undoCommitNote`) }"
                        @click="undoReceipt"
                        data-commit-undo
                    >
                        {{ t(`workspace.reviewPanel.undo`) }}
                    </button>
                    <span class="ml-auto shrink-0 pl-2 text-2xs text-subtle">{{ timeAgo(node.commit.at, { now }) }}</span>
                </div>
            </li>
        </ol>
    </section>
</template>
