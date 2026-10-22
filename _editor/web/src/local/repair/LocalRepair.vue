<script setup lang="ts">
import { Button, CopyButton, growTextarea, Icon, Markdown, Notice, SegmentedControl, toneRim, toneWash } from "@intentic/ui";
import { formatClock, formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { useRoute } from "vue-router";
import type { LocalRepairContext, LocalRepairHost, LocalRepairSession } from "../../app/environments/localHost";
import { localHost } from "../../app/environments/localHost";
import RepairToolCard from "./RepairToolCard.vue";
import { rawLog, repairVerdict, repairWorking } from "./repairSession";

// REPAIR'S PAGE: an agent on this computer, outside every sandbox, for when one is down. One headline over the whole
// session (what it found, or what it waits for), then what it did as cards that read `ic`'s output into rows, and the
// conversation under them; the whole session as the raw text it was is one switch away. The composer is pinned to the
// foot and says why it cannot send rather than going grey: signed out, it is replaced by the sign-in it needs.
// (2026-10-22: the page was a column of raw "Details" and a textarea that was disabled with no word of why.)

const props = defineProps<{
    /** Design-kit and tests inject a host; the app uses the window's own. */
    repair?: LocalRepairHost;
}>();

const t = useT();
const route = useRoute();
const host = computed(() => props.repair ?? localHost()?.repair);
const draft = ref(``);
const mode = ref<`summary` | `raw`>(`summary`);
const composer = useTemplateRef<HTMLTextAreaElement>(`composer`);
const scroller = useTemplateRef<HTMLElement>(`scroller`);

const NO_SESSION: LocalRepairSession = { state: `idle`, messages: [] };
const session = computed((): LocalRepairSession => host.value?.session.value ?? NO_SESSION);
const signedOut = computed(() => session.value.state === `signedOut`);
const offline = computed(() => session.value.state === `offline`);
const working = computed(() => repairWorking(session.value));
const waiting = computed(() => session.value.state === `waiting`);
const busy = computed(() => working.value || waiting.value);
const verdict = computed(() => repairVerdict(session.value));
const empty = computed(() => session.value.messages.length === 0);
const log = computed(() => rawLog(session.value));
// The first change waiting on the reader, which the headline's press brings into view.
const firstAsk = computed(
    () => session.value.messages.find((message) => message.tool?.state === `needsApproval` && message.tool.approvalId !== undefined)?.id,
);
const reviewAsk = (): void => {
    if (firstAsk.value !== undefined) {
        document.getElementById(`repair-${firstAsk.value}`)?.scrollIntoView({ behavior: `smooth`, block: `center` });
    }
};
const canSend = computed(() => !busy.value && !signedOut.value && draft.value.trim() !== ``);

// The reset in the reader's own time and language: the clock alone today, the weekday too when it is later.
const allowanceNote = computed(() => {
    const resetsAt = session.value.allowanceResetsAt;
    if (resetsAt === undefined) {
        return undefined;
    }
    const at = Date.parse(resetsAt);
    if (Number.isNaN(at)) {
        return t(`local.repair.allowanceUsed`, { time: resetsAt });
    }
    const today = new Date(at).toDateString() === new Date().toDateString();
    return t(`local.repair.allowanceUsed`, { time: today ? formatClock(at) : formatWhen(at) });
});

const queryText = (key: string): string | undefined => {
    const value = route.query[key];
    return typeof value === `string` && value !== `` ? value : undefined;
};
const context = computed((): LocalRepairContext => ({ slug: queryText(`slug`), from: queryText(`from`), reason: queryText(`reason`) }));

onMounted(() => {
    if (props.repair === undefined) {
        void host.value?.start(context.value);
    }
});

const runChecks = async (): Promise<void> => {
    await host.value?.start(context.value);
};
const startOver = async (): Promise<void> => {
    draft.value = ``;
    await host.value?.reset();
};

const signIn = (): void => {
    void localHost()?.signIn?.();
};

const answer = async (approvalId: string | undefined, allow: boolean): Promise<void> => {
    if (approvalId !== undefined) {
        await host.value?.answer(approvalId, allow);
    }
};

const send = async (): Promise<void> => {
    const text = draft.value.trim();
    if (!canSend.value || host.value === undefined) {
        return;
    }
    draft.value = ``;
    await nextTick();
    growTextarea(composer.value, COMPOSER_MAX);
    try {
        await host.value.send(text);
    } catch {
        // Not taken (Repair was still on the last one): the words go back where they were typed, not into the void.
        draft.value = text;
    }
};
// Enter sends, Shift+Enter breaks the line; a key that ends an IME composition is the composition's.
const onEnter = (event: KeyboardEvent): void => {
    if (event.isComposing) {
        return;
    }
    event.preventDefault();
    void send();
};

const COMPOSER_MAX = 200;
const onInput = (): void => growTextarea(composer.value, COMPOSER_MAX);

// What arrives lands in view while the reader is at the foot; one who scrolled up to read is left where they are. The
// page opens at its top, on the headline that sums everything under it.
const NEAR_END = 120;
const scrollToEnd = (): void => {
    const element = scroller.value;
    if (element !== null) {
        element.scrollTop = element.scrollHeight;
    }
};
watch(
    () => [session.value.messages.length, session.value.state, mode.value],
    async () => {
        const element = scroller.value;
        const atEnd = element === null || element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END;
        await nextTick();
        if (atEnd) {
            scrollToEnd();
        }
    },
);

const composerHint = computed((): string => {
    if (waiting.value) {
        return t(`local.repair.composer.waiting`);
    }
    if (working.value) {
        return t(`local.repair.composer.working`);
    }
    return t(`local.repair.composer.keys`);
});

const modes = computed(() => [
    { value: `summary` as const, label: t(`local.repair.mode.summary`), icon: `align-left` as const },
    { value: `raw` as const, label: t(`local.repair.mode.raw`), icon: `terminal` as const },
]);
</script>

<template>
    <div class="flex h-full min-h-0 w-full flex-col">
        <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
                <!-- Who this is and what it may do, then the two ways to look at it and the way to begin again. -->
                <header class="flex flex-wrap items-start gap-x-4 gap-y-3">
                    <span class="grid size-10 shrink-0 place-items-center rounded-xl border" :class="toneRim(`primary`, `soft`, toneWash(`primary`))">
                        <Icon name="wrench" class="text-lg" aria-hidden="true" />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <h1 class="text-lg font-semibold leading-tight text-content">{{ t(`local.repair.title`) }}</h1>
                        <p class="text-sm text-muted">{{ t(`local.repair.subtitle`) }}</p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                        <SegmentedControl v-model="mode" :options="modes" size="sm" :aria-label="t(`local.repair.mode.label`)" />
                        <Button
                            v-if="!empty"
                            size="small"
                            tier="quiet"
                            :label="t(`local.repair.reset`)"
                            v-tooltip.bottom="{ title: t(`local.repair.resetTip.title`), note: t(`local.repair.resetTip.note`) }"
                            @click="startOver"
                        >
                            <template #icon><Icon name="refresh" aria-hidden="true" /></template>
                        </Button>
                    </div>
                </header>

                <ul class="-mt-1 flex flex-wrap gap-2 text-2xs text-muted">
                    <li class="inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-2.5 py-1">
                        <Icon name="desktop" aria-hidden="true" />{{ t(`local.repair.promise.thisPc`) }}
                    </li>
                    <li class="inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-2.5 py-1">
                        <Icon name="lock" aria-hidden="true" />{{ t(`local.repair.promise.files`) }}
                    </li>
                    <li class="inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-2.5 py-1">
                        <Icon name="shield" aria-hidden="true" />{{ t(`local.repair.promise.asks`) }}
                    </li>
                </ul>

                <!-- What it was opened for, as the opener said it. -->
                <p v-if="context.slug || context.reason" class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted">
                    <span class="text-subtle">{{ t(`local.repair.openedFor`) }}</span>
                    <code v-if="context.slug" class="rounded bg-overlay px-1.5 py-0.5 font-mono text-2xs text-content">{{ context.slug }}</code>
                    <span v-if="context.reason" class="text-content">{{ context.reason }}</span>
                </p>

                <!-- THE HEADLINE: one sentence over everything below, and the first press when there is nothing yet. -->
                <section
                    class="flex items-center gap-4 rounded-xl border bg-card p-4 md:p-5"
                    :class="toneRim(verdict.tone, `soft`)"
                    aria-live="polite"
                >
                    <span class="grid size-11 shrink-0 place-items-center rounded-full" :class="toneWash(verdict.tone)">
                        <Icon :name="verdict.icon" :spin="verdict.busy" class="text-lg" aria-hidden="true" />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <h2 class="text-sm font-semibold text-content">{{ verdict.title }}</h2>
                        <p v-if="verdict.detail" class="text-xs text-muted">{{ verdict.detail }}</p>
                    </div>
                    <Button v-if="firstAsk !== undefined && mode === `summary`" tier="accent" :label="t(`local.repair.review`)" @click="reviewAsk" />
                    <Button v-if="empty && !working" tier="accent" :label="t(`local.repair.runChecks`)" @click="runChecks">
                        <template #icon><Icon name="play" aria-hidden="true" /></template>
                    </Button>
                </section>

                <Notice v-if="offline" tone="warning" class="text-xs">{{ t(`local.repair.offline`) }}</Notice>
                <Notice v-else-if="allowanceNote" tone="info" class="text-xs">{{ allowanceNote }}</Notice>

                <!-- WHAT HAPPENED, read: the reader's words on the right, Repair's on the left, its tools as cards. -->
                <ol v-if="mode === `summary` && !empty" class="flex flex-col gap-3">
                    <li v-for="message in session.messages" :id="`repair-${message.id}`" :key="message.id" class="flex scroll-mt-4 flex-col">
                        <RepairToolCard v-if="message.tool" :tool="message.tool" :answer="(allow) => answer(message.tool?.approvalId, allow)" />
                        <p
                            v-else-if="message.role === `user`"
                            class="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md px-3.5 py-2 text-sm text-content"
                            :class="toneWash(`primary`)"
                        >
                            {{ message.text }}
                        </p>
                        <div v-else class="flex gap-3">
                            <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-line bg-card text-muted">
                                <Icon name="wrench" class="text-xs" aria-hidden="true" />
                            </span>
                            <Markdown :source="message.text" class="min-w-0 flex-1 text-sm leading-relaxed text-content" />
                        </div>
                    </li>
                    <li v-if="session.state === `thinking`" class="flex items-center gap-3 text-xs text-muted">
                        <span class="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-card">
                            <span class="repair-dots flex gap-0.5" aria-hidden="true"><span /><span /><span /></span>
                        </span>
                        {{ t(`local.repair.thinking`) }}
                    </li>
                </ol>

                <!-- THE SAME SESSION AS TEXT, for the reader who wants every byte, or to paste it somewhere. -->
                <section v-else-if="mode === `raw`" class="overflow-hidden rounded-xl border border-line bg-canvas">
                    <header class="flex items-center gap-2 border-b border-line-subtle px-3 py-2">
                        <Icon name="terminal" class="text-xs text-subtle" aria-hidden="true" />
                        <span class="flex-1 text-xs font-medium text-content">{{ t(`local.repair.rawHeading`) }}</span>
                        <CopyButton v-if="log !== ``" :text="log" :label="t(`local.repair.copyLog`)" />
                    </header>
                    <pre v-if="log !== ``" class="overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-2xs leading-relaxed text-muted">{{
                        log
                    }}</pre>
                    <p v-else class="p-3 text-xs text-subtle">{{ t(`local.repair.rawEmpty`) }}</p>
                </section>
            </div>
        </div>

        <!-- THE COMPOSER, pinned to the foot. Signed out it is the sign-in it needs, not a box that ignores clicks. -->
        <footer class="shrink-0 border-t border-line bg-canvas">
            <div class="mx-auto w-full max-w-3xl px-4 py-3 md:px-8">
                <div v-if="signedOut" class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3">
                    <span class="grid size-8 shrink-0 place-items-center rounded-full" :class="toneWash(`info`)">
                        <Icon name="user" class="text-sm" aria-hidden="true" />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <p class="text-sm font-medium text-content">{{ t(`local.repair.signedOutTitle`) }}</p>
                        <p class="text-xs text-muted">{{ t(`local.repair.signedOut`) }}</p>
                    </div>
                    <Button tier="accent" :label="t(`local.repair.signIn`)" @click="signIn">
                        <template #icon><Icon name="sign-in" aria-hidden="true" /></template>
                    </Button>
                </div>
                <div v-else class="ui-field-shell flex flex-col rounded-xl bg-card" @click="composer?.focus()">
                    <label for="repair-composer" class="sr-only">{{ t(`local.repair.composerPlaceholder`) }}</label>
                    <textarea
                        id="repair-composer"
                        ref="composer"
                        v-model="draft"
                        rows="1"
                        :placeholder="t(`local.repair.composerPlaceholder`)"
                        class="field-bare w-full resize-none px-4 pb-1 pt-3"
                        @input="onInput"
                        @keydown.enter.exact="onEnter"
                    />
                    <div class="flex items-center gap-2 px-3 pb-2">
                        <Icon v-if="busy" :name="waiting ? `shield` : `spinner`" :spin="!waiting" class="text-2xs text-subtle" aria-hidden="true" />
                        <span class="min-w-0 flex-1 truncate text-2xs text-subtle" aria-live="polite">{{ composerHint }}</span>
                        <Button size="small" tier="accent" :label="t(`local.repair.send`)" :disabled="!canSend" @click.stop="send">
                            <template #icon><Icon name="send" aria-hidden="true" /></template>
                        </Button>
                    </div>
                </div>
            </div>
        </footer>
    </div>
</template>

<style scoped>
/* Three dots taking turns: Repair is writing. A keyframe, not a utility: Tailwind has no staggered pulse. */
.repair-dots > span {
    width: 3px;
    height: 3px;
    border-radius: 9999px;
    background: currentColor;
    animation: repair-dot 1.2s ease-in-out infinite;
}
.repair-dots > span:nth-child(2) {
    animation-delay: 0.15s;
}
.repair-dots > span:nth-child(3) {
    animation-delay: 0.3s;
}
@keyframes repair-dot {
    0%,
    80%,
    100% {
        opacity: 0.25;
    }
    40% {
        opacity: 1;
    }
}
:root[data-motion="reduced"] .repair-dots > span {
    animation: none;
    opacity: 0.6;
}
</style>
