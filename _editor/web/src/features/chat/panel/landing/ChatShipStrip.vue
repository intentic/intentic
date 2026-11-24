<!-- THIS CHAT'S LANDED WORK, TAKEN THE REST OF THE WAY: commit it, then push it, from where the reader already is. What it
     shows and when is shipStrip.ts's. The commit is the Changes panel's own run (useChanges.commitRepos), staging this
     chat's files first as its lit From chip would; the push goes through the door every push does (usePushFlow.askSync),
     so a refusal is asked about where every other one is. -->
<script setup lang="ts">
import { landedCommitMessage } from "@intentic/sandbox-contract/state/landed-commit";
import { Button, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { sameScope, SHARED_SCOPE, type ViewScope } from "../../../../app/workspaceScope";
import { holdQuestions } from "../../../../models/changes/indexRuns";
import { openChanges } from "../../../../models/changes/openChanges";
import { forgetSessionCommits, recordSessionCommit, sessionCommitsOf } from "../../../../models/changes/sessionCommits";
import { COMMIT_SCOPE, useChanges } from "../../../../models/changes/useChanges";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { usePushFlow } from "../../../../models/changes/usePushFlow";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import { type PushVerb, sessionCommitsSettled, shipStripOf } from "./shipStrip";
import ChatDockRow from "../dock/ChatDockRow.vue";
import { useDockLit } from "../dock/dockLit";

const props = defineProps<{ agent: FleetAgent }>();

const t = useT();
const words = useVocabulary();
// The commit and the push are this line's bright press, unless an ask the agent waits on is beside it (dockLit.ts).
const lit = useDockLit();

// The shared tree, where a land puts its work: the review the rail already keeps, so reading it here costs no scan.
const changes = useChanges(SHARED_SCOPE);
const pushFlow = usePushFlow();

// The push flow's moments, by the repositories each is about, and only for a push from the shared tree.
const reposOf = (push: { readonly targets: readonly { readonly repo: string }[]; readonly view?: ViewScope } | undefined): readonly string[] =>
    push === undefined || !sameScope(push.view ?? SHARED_SCOPE, SHARED_SCOPE) ? [] : push.targets.map((target) => target.repo);
const pushMoments = computed(() => ({
    running: pushFlow.running.value ? reposOf(pushFlow.pending.value) : [],
    pushed: reposOf(pushFlow.pushed.value),
    refused: pushFlow.question.value === undefined ? reposOf(pushFlow.held.value?.push) : reposOf(pushFlow.pending.value),
}));

const commits = computed(() => sessionCommitsOf(props.agent.id));
const strip = computed(() =>
    shipStripOf({
        id: props.agent.id,
        repos: changes.repos.value,
        committing: changes.committing.value,
        // The card's own sentence: it is written within seconds of the land and replaced by the next one.
        message: props.agent.landedMessage === undefined ? undefined : landedCommitMessage(props.agent.landedMessage),
        draft: props.agent.landedMessageDraft,
        commits: commits.value,
        push: pushMoments.value,
    }),
);

// Forgets what this chat committed once none of it is owed a remote any more (pushed from here, the panel, a terminal),
// or there is no remote to owe; never mid-push, nor while the strip still says the push went.
watch(
    [commits, changes.repos, pushMoments],
    ([held, repos, moments]) => {
        if (held !== undefined && changes.loaded.value && moments.running.length === 0 && moments.pushed.length === 0 && sessionCommitsSettled(held, repos)) {
            forgetSessionCommits(props.agent.id);
        }
    },
    { immediate: true },
);

/* COMMIT. */

// The message the reader types when none was written; kept until a commit takes it.
const typed = ref(``);
// Why the last press here recorded nothing, in git's words or ours; cleared by the next.
const failure = ref<string | undefined>(undefined);
// This press's run, from the click until it ends: a guardrail question it raises is answered in the Changes panel.
const pressing = ref(false);

const commitMessage = computed<string | undefined>(() => {
    const now = strip.value;
    if (now?.kind !== `commit`) {
        return undefined;
    }
    if (now.draft.state === `written`) {
        return now.draft.text;
    }
    return now.draft.state === `missing` && typed.value.trim() !== `` ? typed.value.trim() : undefined;
});
const commitReady = computed(() => commitMessage.value !== undefined && !changes.actionBusy.value && !pressing.value);
const commitHint = computed((): Tip | undefined => {
    const now = strip.value;
    return now?.kind === `commit`
        ? { title: t(`chat.chatShipStrip.commitFiles`, { count: now.files }, now.files), note: t(`chat.chatShipStrip.onlyThisChat`) }
        : undefined;
});

const commit = async (): Promise<void> => {
    const now = strip.value;
    const message = commitMessage.value;
    if (now?.kind !== `commit` || message === undefined || !commitReady.value) {
        return;
    }
    pressing.value = true;
    failure.value = undefined;
    try {
        // Staged first by this chat's origin, so the commit takes its files across every side and nothing else.
        const groups = now.repos.map((repo) => ({ repo, scope: { origin: props.agent.id } }));
        const recorded = await changes.commitRepos(groups, message, true, { label: t(`chat.chatShipStrip.commit`), count: now.files });
        const refused = changes.failures.value.get(COMMIT_SCOPE);
        if (refused !== undefined || !recorded) {
            failure.value = refused?.detail ?? t(`chat.chatShipStrip.nothingCommitted`);
            return;
        }
        recordSessionCommit(props.agent.id, now.repos);
        typed.value = ``;
    } finally {
        pressing.value = false;
    }
};

// A guardrail hold on this press's run, which only the Changes panel asks (IndexRunPrompt).
const awaitingAnswer = computed(() => pressing.value && holdQuestions.value.some((question) => sameScope(question.view ?? SHARED_SCOPE, SHARED_SCOPE)));

const blockReason = computed(() => {
    const now = strip.value;
    if (now?.kind !== `blocked`) {
        return undefined;
    }
    return now.block === `conflicts`
        ? t(`chat.chatShipStrip.blockConflicts`)
        : now.block === `shared`
          ? t(`chat.chatShipStrip.blockShared`)
          : t(`chat.chatShipStrip.blockStaged`);
});

/* PUSH. */

const verbLabel = (verb: PushVerb): string => (verb === `sync` ? words.value.sync : verb === `publish` ? words.value.publish : words.value.push);
const verbIcon = (verb: PushVerb): `sync` | `cloud-upload` | `arrow-up` => (verb === `sync` ? `sync` : verb === `publish` ? `cloud-upload` : `arrow-up`);

const push = (): void => {
    const now = strip.value;
    if (now?.kind !== `push`) {
        return;
    }
    // Named as the Changes panel names a push, so its "Pushed …" line and the rail's read the same either way.
    const what = now.commits > 0 ? t(`workspace.reviewPanel.commitCount`, { count: now.commits }, now.commits) : t(`workspace.reviewPanel.thisBranch`);
    pushFlow.askSync(verbLabel(now.verb), what, now.targets, SHARED_SCOPE);
};
const pushHint = computed((): Tip | undefined => {
    const now = strip.value;
    return now?.kind === `push` && now.others > 0 ? { title: verbLabel(now.verb), note: t(`chat.chatShipStrip.othersHint`) } : undefined;
});
</script>

<template>
    <template v-if="strip !== undefined">
        <!-- Landed: the message it goes in under, read before the press that commits it. -->
        <ChatDockRow v-if="strip.kind === `commit`" icon="check" tone="done" :title="words.landed" role="status" data-ship-strip>
            <template #meta>{{ t(`chat.chatLandStrip.files`, { count: strip.files }, strip.files) }}</template>
            <template #detail>
                <!-- The message the commit goes under: the one drafted at land time, the wait for it, or the reader's own. -->
                <p
                    v-if="strip.draft.state === `written`"
                    class="truncate font-mono"
                    v-tooltip.bottom="strip.draft.text === strip.draft.subject ? undefined : strip.draft.text"
                    data-ship-message
                >
                    {{ strip.draft.subject }}
                </p>
                <p v-else-if="strip.draft.state === `drafting`" class="flex min-w-0 items-center gap-1.5">
                    <Icon name="spinner" spin class="shrink-0 text-link" />
                    <span class="truncate">{{
                        strip.draft.model === undefined ? t(`chat.chatShipStrip.writing`) : t(`chat.chatShipStrip.modelWriting`, { model: strip.draft.model })
                    }}</span>
                </p>
                <input
                    v-else
                    v-model="typed"
                    :class="ui.input({ size: `sm` }, `mt-1 w-full font-mono`)"
                    :placeholder="t(`chat.chatShipStrip.noMessage`)"
                    :aria-label="t(`chat.chatShipStrip.noMessage`)"
                    v-tooltip.bottom="strip.draft.reason"
                    data-ship-message
                    @keydown.enter.prevent="commit"
                />
                <p v-if="failure !== undefined" class="mt-1 flex min-w-0 items-center gap-1.5 text-danger" role="alert" v-tooltip.bottom="failure">
                    <Icon name="exclamation-triangle" class="shrink-0" />
                    <span class="shrink-0 font-medium">{{ t(`chat.chatShipStrip.commitFailed`) }}</span>
                    <span class="truncate">{{ failure }}</span>
                </p>
            </template>
            <template #actions>
                <Button size="small" thumb tier="boring" class="whitespace-nowrap" v-tooltip.bottom="t(`chat.chatShipStrip.openChanges`)" @click="openChanges">{{
                    t(`chat.chatShipStrip.changes`)
                }}</Button>
                <Button
                    size="small"
                    thumb
                    :tier="lit ? `accent` : `boring`"
                    :tone="lit ? `success` : undefined"
                    class="whitespace-nowrap"
                    :disabled="!commitReady"
                    :loading="pressing"
                    v-tooltip.bottom="commitHint"
                    @click="commit"
                >
                    <Icon name="check" />{{ t(`chat.chatShipStrip.commit`) }}
                </Button>
            </template>
        </ChatDockRow>
        <ChatDockRow v-else-if="strip.kind === `blocked`" icon="exclamation-triangle" tone="warning" :title="t(`chat.chatShipStrip.inChanges`)" role="status" data-ship-strip>
            <template #detail>{{ blockReason }}</template>
            <template #actions>
                <Button size="small" thumb :tier="lit ? `accent` : `boring`" class="whitespace-nowrap" @click="openChanges">{{ t(`chat.chatShipStrip.changes`) }}</Button>
            </template>
        </ChatDockRow>
        <ChatDockRow v-else-if="strip.kind === `committing`" icon="spinner" spin tone="busy" :title="t(`chat.chatShipStrip.committing`)" role="status" data-ship-strip>
            <template v-if="awaitingAnswer" #detail>{{ t(`chat.chatShipStrip.answerInChanges`) }}</template>
            <template v-if="awaitingAnswer" #actions>
                <Button size="small" thumb :tier="lit ? `accent` : `boring`" class="whitespace-nowrap" @click="openChanges">{{ t(`chat.chatShipStrip.changes`) }}</Button>
            </template>
        </ChatDockRow>
        <!-- Committed: what the push sends, and the press that sends it, success-toned as every press that ships work is. -->
        <ChatDockRow
            v-else-if="strip.kind === `push`"
            :icon="strip.refused ? `exclamation-triangle` : `check`"
            :tone="strip.refused ? `warning` : `done`"
            :title="strip.refused ? t(`chat.chatShipStrip.pushRefused`) : t(`chat.chatShipStrip.committed`)"
            role="status"
            data-ship-strip
        >
            <template #meta>
                {{ strip.commits > 0 ? t(`chat.chatShipStrip.toPush`, { count: strip.commits }, strip.commits) : t(`chat.chatShipStrip.unpublished`) }}
            </template>
            <template v-if="strip.others > 0" #detail>{{ t(`chat.chatShipStrip.others`, { count: strip.others }, strip.others) }}</template>
            <template #actions>
                <Button v-if="strip.refused && pushFlow.held.value !== undefined" size="small" thumb tier="boring" class="whitespace-nowrap" @click="pushFlow.reopen">{{
                    t(`chat.chatShipStrip.seeWhy`)
                }}</Button>
                <Button
                    size="small"
                    thumb
                    :tier="lit ? `accent` : `boring`"
                    :tone="lit ? `success` : undefined"
                    class="whitespace-nowrap"
                    :disabled="changes.actionBusy.value || pushFlow.running.value"
                    v-tooltip.bottom="pushHint"
                    @click="push"
                >
                    <Icon :name="verbIcon(strip.verb)" />{{ verbLabel(strip.verb) }}
                    <span v-if="strip.commits > 0" class="tabular-nums opacity-70">{{ strip.commits }}</span>
                </Button>
            </template>
        </ChatDockRow>
        <ChatDockRow v-else-if="strip.kind === `pushing`" icon="spinner" spin tone="busy" :title="words.pushing" role="status" data-ship-strip />
        <ChatDockRow
            v-else
            icon="check-circle"
            tone="done"
            :title="t(`workspace.reviewPanel.pushedWhat`, { what: pushFlow.pushed.value?.what ?? `` })"
            role="status"
            data-ship-strip
        />
    </template>
</template>
