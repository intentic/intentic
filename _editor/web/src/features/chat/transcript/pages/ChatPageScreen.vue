<script setup lang="ts">
import { Button, Icon, ui, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, provide, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { z } from "zod";
import { embedded, tellNative } from "../../../../app/environments/nativeApp";
import { mobileChatPath } from "../../../../lib/routes/phoneScreens";
import { CHAT_SURFACE } from "../../../../models/conversations/tools/chatToolSurface";
import { draftInOrigin } from "../../../../models/fleet/freshSession";
import { useSubagentRoster } from "../../../../models/fleet/subagentRoster";
import { useAgents } from "../../../../models/fleet/useAgents";
import { paneSurface } from "../../panel/pane/paneSurface";
import ChatPageFrame from "./ChatPageFrame.vue";
import { usePageScreen } from "./pageScreen";

// ONE PAGE AN AGENT SHOWED, ALONE ON A SCREEN (`/agents/<id>/pages/<page>`): the drawing of it that stands, found by
// its id in its conversation's record (pageLookup.ts), in the same sealed frame the chat draws it in (ChatPageFrame:
// the chat's theme, no network, an opaque origin), given the whole screen. A page that asks is answered here exactly as
// on its card in the chat: through the conversation's one reply. A deep link opens it in any browser; the Android app
// opens it in its WebView (app/environments/nativeApp.ts), which keeps the address rather than handing it over. What is
// drawn and answered is pageScreen.ts's; it is read when the screen opens and again when it comes back into view,
// since nothing streams to it.

const t = useT();
const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const inApp = embedded();
const { agentById } = useAgents();
const { sessions } = useSubagentRoster();

// The address's two ids; a repeated or missing one names nothing.
const ParamSchema = z.string().catch(``);
const conversationId = computed(() => ParamSchema.parse(route.params[`id`]));
const pageId = computed(() => ParamSchema.parse(route.params[`page`]));

const { record, reading, read, page, asked, settling, submit, dismiss } = usePageScreen(
    () => conversationId.value,
    () => pageId.value,
);
// Its paths are the agent's own copy of the workspace where it has one, as its chat's are (agentTabOf).
watch(
    [record, () => agentById(conversationId.value)?.branch],
    ([held, branch]) => {
        held.isolated.value = branch !== undefined;
    },
    { immediate: true },
);
provide(
    CHAT_SURFACE,
    paneSurface(
        () => record.value,
        router,
        () => sessions.value,
    ),
);

// Back into view (the app showing its WebView again, a tab brought forward): the record may have moved on meanwhile.
const onVisible = (): void => {
    if (document.visibilityState === `visible` && reading.value !== `reading`) {
        void read();
    }
};
onMounted(() => document.addEventListener(`visibilitychange`, onVisible));
onBeforeUnmount(() => document.removeEventListener(`visibilitychange`, onVisible));

// Words the page offers for the composer (`intentic.send`) go to the conversation's own: the app's, inside the app;
// otherwise its chat here, opened with them after whatever was already written, as a fresh session's findings are.
const toComposer = (text: string): void => {
    if (tellNative({ kind: `compose`, conversationId: conversationId.value, text })) {
        return;
    }
    const agent = agentById(conversationId.value);
    if (agent !== undefined) {
        draftInOrigin(agent, text);
    }
};

// The way back, outside the app (whose toolbar is its own): a step back where this screen was reached from inside the
// app, else the conversation it came from.
const SteppedSchema = z.object({ back: z.string() });
const back = (): void => {
    if (SteppedSchema.safeParse(router.options.history.state).success) {
        router.back();
        return;
    }
    void router.push(mobile.value ? mobileChatPath(conversationId.value) : { path: `/`, query: { conversation: conversationId.value } });
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col bg-canvas" data-chat-page-screen>
        <header class="flex min-h-12 shrink-0 items-center gap-1 border-b border-line pr-3" :class="inApp ? `pl-3.5` : `pl-1`">
            <button v-if="!inApp" type="button" :class="ui.iconButton({ size: `lg` }, `shrink-0`)" :aria-label="t(`ui.action.back`)" @click="back">
                <Icon name="arrow-left" class="text-base" />
            </button>
            <h1 class="min-w-0 flex-1 truncate text-sm font-medium">{{ page?.title ?? t(`chat.chatPages.screenTitle`) }}</h1>
            <Button v-if="asked?.status === `pending`" tier="boring" size="small" :disabled="settling" :label="t(`chat.chatPages.dismiss`)" @click="void dismiss()" />
        </header>
        <p v-if="asked?.status === `pending`" class="shrink-0 px-3.5 pt-2 text-xs text-muted">{{ t(`chat.chatPages.askHint`) }}</p>
        <!-- Inset as in the chat, where the page lines up with the prose around it, so it reads as the same page. -->
        <div class="relative min-h-0 flex-1 px-3.5 pt-2">
            <ChatPageFrame v-if="page" :key="page.path" :page="page" :submit="submit" :message="toComposer" fill />
            <p v-else-if="reading === `reading`" class="py-1 text-xs text-muted">{{ t(`chat.chatPages.opening`) }}</p>
            <p v-else-if="reading === `gone`" class="py-1 text-xs text-muted">{{ t(`chat.chatPages.conversationGone`) }}</p>
            <div v-else-if="reading === `failed`" class="flex flex-col items-start gap-2 py-1">
                <p class="text-xs text-muted">{{ t(`chat.chatPages.readFailed`) }}</p>
                <Button tier="boring" size="small" :label="t(`ui.action.retry`)" @click="read" />
            </div>
            <p v-else class="py-1 text-xs text-muted">{{ t(`chat.chatPages.notFound`) }}</p>
        </div>
    </div>
</template>
