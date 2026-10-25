<!-- A sandbox's own view, shown on Home where the chat was (lib/routes/homeDetour.ts): a labelled way back to the chat, then the
     view as its own page. The chat stays mounted underneath (HomeChat.vue), so going back finds it as it was left. -->
<script lang="ts">
import type { Component } from "vue";
import type { HomeViewKey } from "../../lib/routes/homeDetour";
import { lazySection } from "../../workbench/hub/lazySection";

// Each view's code is fetched when it is first shown, as a hub section's is; module scope, so a view shown once draws at
// once from then on.
const VIEWS = {
    models: lazySection(`SandboxModels`, () => import(`../sandbox/models/SandboxModels.vue`)),
} satisfies Record<HomeViewKey, Component>;
</script>

<script setup lang="ts">
import { PageHeader, Page, providePageBack, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, provide, useTemplateRef } from "vue";
import { useRoute, useRouter } from "vue-router";
import { backIsHome, HOME_VIEW_HOST, homeChatOf, type LandedModel } from "../../lib/routes/homeDetour";
import { homeConversation } from "../../models/home/homeChat";
import { providerReadyOn } from "../../models/providers/access";

const { view } = defineProps<{ view: HomeViewKey }>();

const t = useT();
const route = useRoute();
const router = useRouter();

// The page's name, as the sandbox's own menu names the same view.
const TITLES = {
    models: () => t(`shared.models`),
} satisfies Record<HomeViewKey, () => string>;

// What a view connected becomes the chat's model when the chat could not send and has not started: the same rule the
// app's own repoint keeps (useChat-accounts.ts), which a key or a local model, never on its ladder, would not reach.
const pointChatAt = (landed: LandedModel): void => {
    const chat = homeConversation.value;
    const fresh = chat !== undefined && chat.session.value === undefined && chat.transcript.messages.value.length === 0;
    if (fresh && !providerReadyOn(chat.selection.provider.value, chat.selection.harness.value)) {
        chat.selection.apply({ kind: `selectModel`, pick: landed });
    }
};

// Back is a step back in history when the chat is the entry before this one, so the browser's own Back and this press
// agree; otherwise (a reload, a link) the address is replaced, never walking out of the app.
const back = (landed?: LandedModel): void => {
    if (landed !== undefined) {
        pointChatAt(landed);
    }
    if (backIsHome(router.options.history.state, route)) {
        router.back();
        return;
    }
    void router.replace(homeChatOf(route));
};
provide(HOME_VIEW_HOST, { back });
// This page carries its own way back, labelled; a shell's arrow beside the title would be a second one going elsewhere.
providePageBack(computed(() => undefined));

// Focus moves to the page it opened, as a page change does, so a keyboard and a screen reader start here, and Esc reaches it.
const frame = useTemplateRef<HTMLElement>(`frame`);
onMounted(() => frame.value?.focus({ preventScroll: true }));

// Esc goes back too, unless it was meant for a field being typed in or something the view itself closed with it.
const onEscape = (event: KeyboardEvent): void => {
    const typing = event.target instanceof Element && event.target.closest(`input, textarea, select, [contenteditable="true"]`) !== null;
    if (!event.defaultPrevented && !typing) {
        back();
    }
};
</script>

<template>
    <section
        ref="frame"
        tabindex="-1"
        class="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        :aria-label="TITLES[view]()"
        data-home-view-shown
        @keydown.esc="onEscape"
    >
        <div class="min-h-0 flex-1 overflow-y-auto">
            <Page>
                <button type="button" :class="ui.textButton({}, `mb-3 font-medium`)" @click="back()">
                    <Icon name="arrow-left" class="text-xs" aria-hidden="true" />{{ t(`home.view.back`) }}
                </button>
                <PageHeader :title="TITLES[view]()" />
                <component :is="VIEWS[view]" />
            </Page>
        </div>
    </section>
</template>
