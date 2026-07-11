<script setup lang="ts">
import type { ActivityEvent } from "@intentic-app/api-contract";
import { Card, cmp, InfoHint, Page, Segmented, StatusBadge, type IconName, type StatusVariant } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { timeAgo } from "../../pages/workspace/format";
import { useActivity } from "./useActivity";

/* The agent-activity extension: the audit surface for what the agent does through its connected provider
 * capabilities (Discord first). TOP is connection health — per-bot gateway state plus the live voice session.
 * BELOW is the feed: inbound messages that woke automations, the agent's sniffed outbound API calls, and
 * system events (wake outcomes, failures), filterable by direction. Read-only — the log is daemon-written. */

type Direction = `all` | `in` | `out` | `system`;

const { events, status, error, isLoading } = useActivity();

const direction = ref<Direction>(`all`);
const filtered = computed(() => (direction.value === `all` ? events.value : events.value.filter((event) => event.direction === direction.value)));

// Click-to-expand for long content; collapsed rows line-clamp.
const expanded = ref(new Set<string>());
const toggle = (id: string): void => {
    expanded.value = new Set(expanded.value.has(id) ? [...expanded.value].filter((entry) => entry !== id) : [...expanded.value, id]);
};

const gatewayVariant = (gateway: string): StatusVariant => (gateway === `ready` ? `success` : gateway === `connecting` ? `warning` : `neutral`);
const gatewayLabel = (gateway: string): string => (gateway === `ready` ? `Connected` : gateway === `connecting` ? `Connecting` : `Not listening`);

const directionIcon = (event: ActivityEvent): { name: IconName; class: string } =>
    event.direction === `in`
        ? { name: `arrow-down-left`, class: `text-info` }
        : event.direction === `out`
          ? { name: `arrow-up-right`, class: `text-link` }
          : { name: `cog`, class: `text-subtle` };

const TYPE_LABELS: Record<string, string> = {
    "message.received": `Message received`,
    "voice_transcript.received": `Voice transcript`,
    "message.send": `Message sent`,
    "messages.read": `Messages read`,
    "reaction.add": `Reaction added`,
    "api.call": `API call`,
    "gateway.login_failed": `Gateway login failed`,
    "dispatch.failed": `Dispatch failed`,
    "voice.session_started": `Voice session started`,
    "voice.session_ended": `Voice session ended`,
    "automation.run": `Automation run`,
    "turn.started": `Turn started`,
    "turn.plan": `Plan proposed`,
    "turn.error": `Turn error`,
    "turn.completed": `Turn completed`,
};
const typeLabel = (event: ActivityEvent): string => TYPE_LABELS[event.type] ?? event.type;

const voiceMinutes = computed(() => (status.value?.voice === undefined ? 0 : Math.round((Date.now() - status.value.voice.startedAt) / 60_000)));
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page class="max-w-none">
            <header class="mb-6">
                <div class="flex items-center gap-2">
                    <h1 class="text-2xl font-semibold">Agent activity</h1>
                    <InfoHint label="Agent activity">
                        <span class="block text-sm font-medium text-content">Agent activity</span>
                        <span class="mt-1 block text-xs text-muted">
                            The audit trail of the agent's provider interactions: <b>inbound</b> messages that woke it, its <b>outbound</b> API calls,
                            and <b>system</b> events (wake outcomes, connection failures, voice sessions).
                        </span>
                    </InfoHint>
                </div>
                <p class="mt-1 text-sm text-muted">What the agent heard, said, and did through its connected capabilities.</p>
            </header>

            <div v-if="error" :class="cmp.alertDanger('mb-4 px-4 py-3 text-sm')">{{ error }}</div>

            <div class="flex flex-col gap-4">
                <!-- Connection health: one card per provider bot, straight from the daemon's live probe. -->
                <section class="rounded-lg border border-line bg-card p-4">
                    <h3 :class="cmp.sectionLabel('mb-3')">Connections</h3>
                    <div class="flex flex-col gap-2">
                        <Card v-for="connection in status?.connections ?? []" :key="connection.capabilityId" class="flex flex-col gap-1">
                            <div class="flex items-center gap-2">
                                <span class="font-medium capitalize text-content">{{ connection.provider }}</span>
                                <span class="truncate font-mono text-2xs text-subtle">{{ connection.capabilityId }}</span>
                                <StatusBadge :variant="gatewayVariant(connection.gateway)" :label="gatewayLabel(connection.gateway)" size="xs" dot />
                            </div>
                            <p v-if="connection.lastError" class="text-xs text-danger">{{ connection.lastError }}</p>
                        </Card>
                        <p v-if="(status?.connections ?? []).length === 0 && !isLoading" class="py-4 text-center text-sm text-muted">
                            No monitored provider capabilities connected.
                        </p>
                    </div>

                    <!-- The daemon-held voice session, while one is live. -->
                    <Card v-if="status?.voice" class="mt-2 flex items-center gap-2">
                        <Icon name="microphone" class="text-info" />
                        <span class="font-medium text-content">#{{ status.voice.channelName }}</span>
                        <StatusBadge variant="info" label="Transcribing" size="xs" dot />
                        <span class="text-xs text-muted">
                            {{ voiceMinutes }} min —
                            {{ status.voice.participants.length > 0 ? status.voice.participants.join(`, `) : `no speakers yet` }}
                        </span>
                    </Card>
                </section>

                <!-- The feed: newest first, filterable by direction. -->
                <section class="rounded-lg border border-line bg-card p-4">
                    <div class="mb-3 flex items-center justify-between gap-3">
                        <h3 :class="cmp.sectionLabel()">Feed</h3>
                        <Segmented
                            v-model="direction"
                            :options="[
                                { label: `All`, value: `all` },
                                { label: `Inbound`, value: `in` },
                                { label: `Outbound`, value: `out` },
                                { label: `System`, value: `system` },
                            ]"
                        />
                    </div>

                    <div class="flex flex-col divide-y divide-line">
                        <div v-for="event in filtered" :key="event.id" class="flex items-start gap-3 py-2.5">
                            <Icon v-bind="directionIcon(event)" class="mt-0.5 text-xs" />
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span class="text-sm font-medium text-content">{{ typeLabel(event) }}</span>
                                    <StatusBadge v-if="event.outcome === `error`" variant="danger" label="Error" size="xs" dot />
                                    <span v-if="event.author" class="text-xs text-muted">from {{ event.author }}</span>
                                    <span v-if="event.channelId" class="font-mono text-2xs text-subtle">#{{ event.channelId }}</span>
                                    <span v-if="event.method" class="font-mono text-2xs text-subtle">{{ event.method }} {{ event.endpoint }}</span>
                                </div>
                                <p
                                    v-if="event.content"
                                    class="mt-0.5 cursor-pointer whitespace-pre-wrap break-words text-xs text-muted"
                                    :class="expanded.has(event.id) ? `` : `line-clamp-2`"
                                    @click="toggle(event.id)"
                                >
                                    {{ event.content }}
                                </p>
                                <p v-if="event.error" class="mt-0.5 break-words text-xs text-danger">{{ event.error }}</p>
                                <div class="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-2xs text-subtle/70">
                                    <span v-if="event.automationIds?.length">automations: {{ event.automationIds.join(`, `) }}</span>
                                    <span v-if="event.sessionId">session: {{ event.sessionId }}</span>
                                </div>
                            </div>
                            <span class="shrink-0 text-2xs text-subtle" :title="new Date(event.at).toLocaleString()">{{ timeAgo(event.at) }}</span>
                        </div>
                        <p v-if="filtered.length === 0 && !isLoading" class="py-6 text-center text-sm text-muted">
                            Nothing yet. Events appear when a message wakes the agent, or when it calls a connected provider's API.
                        </p>
                    </div>
                </section>
            </div>
        </Page>
    </div>
</template>
