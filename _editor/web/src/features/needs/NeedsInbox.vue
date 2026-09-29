<!-- Needs you: everything agents are waiting on people for, answered here, and what else is parked on a person. -->
<script setup lang="ts">
import { isOpenNeed, type Need } from "@intentic/sandbox-contract";
import { Page, PageHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { attentionReason, awaitingUser } from "../agents/fleet/agentStatus";
import { useAgents } from "../agents/fleet/useAgents";
import NeedCard from "./NeedCard.vue";
import StandingGrants from "./StandingGrants.vue";
import { useNeeds } from "./useNeeds";

const t = useT();

const { needs, open } = useNeeds();
const { fleet, agentById } = useAgents();

// Grouped by the conversation that asked, oldest ask first, so what has waited longest leads.
interface Group {
    readonly conversationId: string;
    readonly title: string;
    readonly needs: readonly Need[];
}
// A conversation the board no longer lists (archived away, or on a roster this reader is not shown) still has a name.
const titleOf = (conversationId: string): string => agentById(conversationId)?.title ?? t(`needs.inbox.untitled`);
const groups = computed<readonly Group[]>(() => {
    const byConversation = new Map<string, Need[]>();
    for (const need of [...open.value].sort((left, right) => left.createdAt - right.createdAt)) {
        byConversation.set(need.conversationId, [...(byConversation.get(need.conversationId) ?? []), need]);
    }
    return [...byConversation.entries()].map(([conversationId, list]) => ({ conversationId, title: titleOf(conversationId), needs: list }));
});

// Cards a turn is parked on right now (a plan, a question, a permission, a payment, a hand-off): answered in their own
// chat, where the turn is waiting, so listed here with the way there.
const parked = computed(() => fleet.value.filter((agent) => awaitingUser(agent) || agent.attention.credential));

// The recent answers, for "did I already do that": newest first, a handful.
const showAnswered = ref(false);
const answered = computed(() => needs.value.filter((need) => !isOpenNeed(need)).slice(0, 12));

const chatOf = (conversationId: string) => ({ path: `/`, query: { conversation: conversationId } });
</script>

<template>
    <Page>
        <PageHeader :title="t(`needs.inbox.title`)" :description="t(`needs.inbox.description`)" />

        <section v-for="group in groups" :key="group.conversationId" class="mb-6 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
                <h2 class="min-w-0 truncate text-sm font-semibold text-content">{{ group.title }}</h2>
                <RouterLink :to="chatOf(group.conversationId)" class="shrink-0 text-2xs text-link">{{ t(`needs.inbox.openChat`) }}</RouterLink>
            </div>
            <NeedCard v-for="need in group.needs" :key="need.id" :need-id="need.id" />
        </section>

        <!-- Only when nothing at all waits: a turn parked on a permission below is something that needs you too. -->
        <p v-if="groups.length === 0 && parked.length === 0" class="mb-6 flex items-center gap-2 text-sm text-muted">
            <Icon name="check-circle" class="text-success" />{{ t(`needs.inbox.nothing`) }}
        </p>

        <section v-if="parked.length > 0" class="mb-6 flex flex-col gap-1">
            <h2 class="text-sm font-semibold text-content">{{ t(`needs.inbox.parked`) }}</h2>
            <p class="text-2xs text-muted">{{ t(`needs.inbox.parkedHint`) }}</p>
            <RouterLink
                v-for="agent in parked"
                :key="agent.id"
                :to="chatOf(agent.id)"
                class="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-hover"
            >
                <span class="min-w-0 truncate text-content">{{ agent.title ?? agent.id }}</span>
                <span class="shrink-0 text-2xs text-warning">{{ attentionReason(agent) }}</span>
            </RouterLink>
        </section>

        <StandingGrants :title-of="titleOf" />

        <section v-if="answered.length > 0" class="flex flex-col gap-2">
            <button type="button" class="self-start text-2xs font-medium text-link hover:underline" :aria-expanded="showAnswered" @click="showAnswered = !showAnswered">
                {{ showAnswered ? t(`needs.inbox.hideAnswered`) : t(`needs.inbox.showAnswered`, { count: answered.length }) }}
            </button>
            <template v-if="showAnswered">
                <NeedCard v-for="need in answered" :key="need.id" :need-id="need.id" />
            </template>
        </section>
    </Page>
</template>
