<script setup lang="ts">
import { Button, Icon, Notice, ui } from "@intentic/ui";
import { formatClock, formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import type { LocalRepairHost, LocalRepairSession } from "../../app/environments/localHost";
import { localHost } from "../../app/environments/localHost";

const props = defineProps<{
    /** Design-kit and tests inject a host; the app uses the window's own. */
    repair?: LocalRepairHost;
}>();

const t = useT();
const route = useRoute();
const host = computed(() => props.repair ?? localHost()?.repair);
const draft = ref(``);
const openDetails = ref<Record<string, boolean>>({});
const started = ref(false);

const NO_SESSION: LocalRepairSession = { state: `idle`, messages: [] };
const session = computed((): LocalRepairSession => host.value?.session.value ?? NO_SESSION);
const thinking = computed(() => session.value.state === `thinking`);
const waiting = computed(() => session.value.state === `waiting`);
const signedOut = computed(() => session.value.state === `signedOut`);
const offline = computed(() => session.value.state === `offline`);
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

const contextFromRoute = (): { slug?: string; from?: string; reason?: string } => ({
    slug: typeof route.query[`slug`] === `string` ? route.query[`slug`] : undefined,
    from: typeof route.query[`from`] === `string` ? route.query[`from`] : undefined,
    reason: typeof route.query[`reason`] === `string` ? route.query[`reason`] : undefined,
});

onMounted(() => {
    if (props.repair !== undefined || started.value) {
        return;
    }
    started.value = true;
    void host.value?.start(contextFromRoute());
});

const toggleDetails = (id: string): void => {
    openDetails.value = { ...openDetails.value, [id]: !openDetails.value[id] };
};

const signIn = (): void => {
    void localHost()?.signIn?.();
};

const send = async (): Promise<void> => {
    const text = draft.value.trim();
    if (text === `` || host.value === undefined || thinking.value || waiting.value || signedOut.value) {
        return;
    }
    draft.value = ``;
    await host.value.send(text);
};
</script>

<template>
    <div class="mx-auto flex min-h-0 w-full max-w-2xl flex-col gap-4 p-4 md:p-6">
        <header class="flex flex-col gap-1 border-b border-line pb-3">
            <div class="flex items-start gap-3">
                <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-info-fill text-content">
                    <Icon name="wrench" class="size-4" />
                </span>
                <div class="min-w-0">
                    <h1 class="text-base font-semibold text-content">{{ t(`local.repair.title`) }}</h1>
                    <p class="text-xs text-muted">{{ t(`local.repair.subtitle`) }}</p>
                </div>
            </div>
            <p class="text-xs text-muted">{{ t(`local.repair.bannerSafe`) }}</p>
        </header>

        <div
            v-if="signedOut"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs text-muted"
        >
            <span class="min-w-0 flex-1">{{ t(`local.repair.signedOut`) }}</span>
            <Button size="small" :label="t(`local.repair.signIn`)" @click="signIn" />
        </div>
        <Notice v-else-if="offline" tone="warning">
            <p class="text-xs">{{ t(`local.repair.offline`) }}</p>
        </Notice>
        <Notice v-else-if="allowanceNote" tone="info">
            <p class="text-xs">{{ allowanceNote }}</p>
        </Notice>

        <ul class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <li v-for="message in session.messages" :key="message.id" class="flex flex-col gap-1 text-sm">
                <p
                    v-if="message.role === 'user'"
                    class="self-end rounded-lg bg-primary-fill px-3 py-2 text-content"
                >
                    {{ message.text }}
                </p>
                <p v-else-if="message.role === 'assistant'" class="leading-relaxed text-content">{{ message.text }}</p>
                <div
                    v-if="message.tool"
                    class="flex flex-col gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs text-muted"
                >
                    <div class="flex flex-wrap items-center gap-2">
                        <Icon
                            v-if="message.tool.state === 'running'"
                            name="spinner"
                            spin
                            class="size-3 shrink-0 text-info"
                        />
                        <span
                            v-else
                            class="size-2 shrink-0 rounded-full"
                            :class="
                                message.tool.state === 'done'
                                    ? 'bg-success'
                                    : message.tool.state === 'failed'
                                      ? 'bg-danger'
                                      : 'bg-warning'
                            "
                        />
                        <span class="min-w-0 flex-1 text-content">{{ message.tool.summary }}</span>
                        <template v-if="message.tool.state === 'needsApproval' && message.tool.approvalId">
                            <Button
                                size="small"
                                :label="t(`local.repair.allow`)"
                                @click="host?.answer(message.tool.approvalId, true)"
                            />
                            <Button
                                size="small"
                                tier="boring"
                                :label="t(`local.repair.deny`)"
                                @click="host?.answer(message.tool.approvalId, false)"
                            />
                        </template>
                    </div>
                    <div v-if="message.tool.detail" class="flex flex-col gap-1">
                        <button type="button" :class="ui.textButton()" @click="toggleDetails(message.id)">
                            {{ openDetails[message.id] ? t(`local.repair.hideDetails`) : t(`local.repair.showDetails`) }}
                        </button>
                        <pre
                            v-if="openDetails[message.id]"
                            class="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line-subtle bg-canvas p-2 text-2xs text-subtle"
                            >{{ message.tool.detail }}</pre
                        >
                    </div>
                </div>
            </li>
            <li v-if="thinking" class="text-xs text-muted">{{ t(`local.repair.thinking`) }}</li>
            <li v-else-if="waiting" class="text-xs text-muted">{{ t(`local.repair.waitingForOk`) }}</li>
        </ul>

        <p class="text-xs text-muted">{{ t(`local.repair.approvalHint`) }}</p>

        <div class="flex flex-col gap-2">
            <textarea
                v-model="draft"
                :disabled="signedOut || thinking || waiting"
                :placeholder="t(`local.repair.composerPlaceholder`)"
                rows="2"
                :class="[ui.input(), `min-h-16 w-full resize-y`]"
                @keydown.enter.exact.prevent="send"
            />
            <div class="flex flex-wrap gap-2">
                <Button
                    size="small"
                    :label="t(`local.repair.send`)"
                    :disabled="signedOut || thinking || waiting || draft.trim() === ''"
                    @click="send"
                />
                <button type="button" :class="ui.textButton()" @click="host?.reset()">{{ t(`local.repair.reset`) }}</button>
            </div>
        </div>
    </div>
</template>
