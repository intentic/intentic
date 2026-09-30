<!-- One thing waiting on a person, opened: what it is and who asked, the agent's own case for it, and its answer, which
     is the same control it has wherever else it is drawn (the need's card, the board's permission, the view's presses). -->
<script setup lang="ts">
import { BrandMark, Code, Notice, timeAgo, useNow } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAgents } from "../../agents/fleet/useAgents";
import ChatDecisionButton from "../../chat/transcript/cards/ChatDecisionButton.vue";
import NeedAnswer from "../NeedAnswer.vue";
import { workingLine } from "../needStatus";
import AskAnswer from "./AskAnswer.vue";
import type { InboxItem } from "./inboxItems";
import ParkedAnswer from "./ParkedAnswer.vue";

const t = useT();

const props = defineProps<{ item: InboxItem }>();

const now = useNow();
const asked = computed(() => (props.item.createdAt === undefined ? undefined : timeAgo(props.item.createdAt, { now: now.value, days: true })));

// Where the thing came from, as a link when it has a page of its own: the conversation that asked, the view that holds it.
interface Source {
    readonly label: string;
    readonly to: string | { readonly path: string; readonly query: Readonly<Record<string, string>> };
}
const sourceOf = (item: InboxItem): Source => {
    switch (item.source) {
        case `need`:
            return { label: item.context ?? ``, to: { path: `/`, query: { conversation: item.need.conversationId } } };
        case `chat`:
            return { label: t(`needs.inbox.openChat`), to: { path: `/`, query: { conversation: item.agent.id } } };
        case `view`:
            return { label: item.context ?? item.view.label, to: item.ask.open };
        case `wake`:
            return { label: item.wake.automationId, to: `/ext/automations` };
        case `install`:
            return { label: item.context ?? ``, to: `/sandbox/extensions` };
    }
};
const source = computed(() => sourceOf(props.item));

// The agent's own words for why, where there are any: a need's `why`.
const why = computed(() => (props.item.source === `need` ? props.item.need.why : undefined));

// A held wake's two answers, through the board's own release so the row leaves on the press.
const { releaseHeld } = useAgents();
const { busy, notice, run } = useAsyncAction();
const release = (id: string, verb: `approve` | `reject`): Promise<void> => run(() => releaseHeld(id, verb), t(`needs.inbox.wakeCouldNot`));

const TONE_INK = { danger: `text-danger`, blocking: `text-warning`, waiting: `text-muted` } as const;
const ink = computed(() => TONE_INK[props.item.broken === true ? `danger` : props.item.group]);
</script>

<template>
    <article class="flex max-w-read flex-col gap-5">
        <header class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <BrandMark v-if="item.logo" :size="16" :name="item.kind" :logo="item.logo" />
                <Icon v-else :name="item.icon" :class="ink" />
                <span class="font-medium" :class="ink">{{ item.kind }}</span>
                <template v-if="source.label">
                    <span class="text-subtle">·</span>
                    <RouterLink :to="source.to" class="min-w-0 truncate text-link hover:underline">{{ source.label }}</RouterLink>
                </template>
                <span v-if="asked" class="ml-auto shrink-0 text-2xs tabular-nums text-subtle">{{ asked }}</span>
            </div>
            <h2 class="text-lg font-semibold leading-snug text-content">{{ item.title }}</h2>
            <span v-if="item.group === `blocking`" class="inline-flex w-fit items-center gap-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning">
                <Icon name="pause" />{{ t(`needs.inbox.groupBlocking`) }}
            </span>
        </header>

        <!-- The agent's case, set apart: it is the only part of a need in the agent's own words. -->
        <section v-if="why" class="flex flex-col gap-1 border-l-2 border-line pl-3">
            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`needs.inbox.agentsCase`) }}</span>
            <p class="text-sm leading-relaxed text-content/90">{{ why }}</p>
        </section>

        <template v-if="item.source === `need`">
            <p v-if="workingLine(item.need)" class="flex items-center gap-1.5 text-xs text-muted"><Icon name="spinner" spin class="text-link" />{{ workingLine(item.need) }}</p>
            <p v-if="item.need.unattended" class="text-xs text-subtle">{{ t(`needs.card.unattended`) }}</p>
            <!-- `:key` so moving to the next need never keeps the last one's typed-in form. -->
            <div class="flex flex-col gap-2"><NeedAnswer :key="item.need.id" :need="item.need" /></div>
        </template>

        <ParkedAnswer v-else-if="item.source === `chat`" :key="item.agent.id" :agent="item.agent" />

        <AskAnswer v-else-if="item.source === `view`" :key="item.key" :view="item.view" :ask="item.ask" />

        <template v-else-if="item.source === `wake`">
            <p class="text-sm text-content/85">{{ t(`needs.inbox.wakeWaits`) }}</p>
            <section v-if="item.wake.payload" class="flex flex-col gap-1.5">
                <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`needs.inbox.wakePayload`) }}</span>
                <Code :code="item.wake.payload" :scroll-lines="10" />
            </section>
            <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-2">
                    <ChatDecisionButton tone="primary" icon="play" :disabled="busy" @click="release(item.wake.id, `approve`)">{{ t(`needs.inbox.wakeStart`) }}</ChatDecisionButton>
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="busy" @click="release(item.wake.id, `reject`)">{{ t(`needs.inbox.wakeDrop`) }}</ChatDecisionButton>
                </div>
                <Notice v-if="notice" :of="notice" />
            </div>
        </template>

        <!-- Approved where the powers are read in full and the extension host reloads what the yes lets in. -->
        <template v-else-if="item.source === `install`">
            <section class="flex flex-col gap-1.5">
                <p class="text-sm text-content/85">
                    {{
                        item.extension.powers.added.length === 0
                            ? t(`needs.inbox.installAsksNothing`)
                            : item.extension.approvedBefore
                              ? t(`needs.inbox.installMoreSince`)
                              : t(`needs.inbox.installRunsNothing`)
                    }}
                </p>
                <ul v-if="item.extension.powers.added.length > 0" class="flex flex-col gap-0.5 text-xs text-content">
                    <li v-for="power in item.extension.powers.added" :key="power">+ {{ power }}</li>
                </ul>
            </section>
            <div>
                <ChatDecisionButton tone="primary" icon="extensions" to="/sandbox/extensions">{{ t(`needs.inbox.reviewInExtensions`) }}</ChatDecisionButton>
            </div>
        </template>
    </article>
</template>
