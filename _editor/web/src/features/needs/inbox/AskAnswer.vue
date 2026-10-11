<!-- An extension view's ask (ViewRegistration.asks): what to read before deciding, the presses it offers in place, and
     the way into the view that handles it in depth. A press that throws says so under the presses, in its own words. -->
<script setup lang="ts">
import type { ViewAsk, ViewAskAction, ViewRegistration } from "@intentic/extension-api";
import { Markdown, Notice } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { useOperation } from "../../../workbench/operations/operations";
import ChatDecisionButton from "../../chat/transcript/cards/ChatDecisionButton.vue";

const t = useT();

const props = defineProps<{ view: ViewRegistration; ask: ViewAsk }>();

// At most three, the yes first: the API's promise, held here rather than trusted.
const presses = (): readonly ViewAskAction[] => (props.ask.actions ?? []).slice(0, 3);
const glyph = (action: ViewAskAction) => (action.icon !== undefined && isIconName(action.icon) ? action.icon : undefined);

// The press is the ask's, in the operations ledger: an extension's action runs for as long as it runs (a post going out,
// hooks starting), so leaving the inbox mid-press keeps it held where it is drawn again, and its refusal is still said
// there, or raised wherever the reader is if it ends with nobody on it.
const pressing = useOperation(() => `needs/asks/${props.view.id}/${props.ask.id}`);
const busy = pressing.busy;
const notice = pressing.failure;
const press = async (action: ViewAskAction): Promise<void> => {
    await pressing.run({
        what: `${action.label}: ${props.ask.title}`,
        tag: action.label,
        failed: t(`needs.inbox.askCouldNot`),
        task: () => action.run(),
    });
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- The thing itself, as its words will go out: kept whole, clamped by height rather than cut. -->
        <div v-if="ask.body" class="ui-softscroll max-h-80 overflow-y-auto rounded-lg bg-card shadow-sm px-4 py-3 text-sm leading-relaxed text-content">
            <Markdown v-if="ask.bodyFormat === `markdown`" :source="ask.body" />
            <p v-else class="whitespace-pre-wrap break-words">{{ ask.body }}</p>
        </div>
        <div class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton
                    v-for="action in presses()"
                    :key="action.label"
                    :tone="action.tone === `primary` ? `primary` : `secondary`"
                    :icon="glyph(action)"
                    :disabled="busy"
                    :class="action.tone === `danger` ? `hover:text-danger` : ``"
                    @click="press(action)"
                    >{{ action.label }}</ChatDecisionButton
                >
                <ChatDecisionButton tone="secondary" icon="arrow-up-right" :to="ask.open">{{ t(`needs.inbox.openIn`, { view: view.label }) }}</ChatDecisionButton>
            </div>
            <span v-if="ask.note" class="text-2xs text-subtle">{{ ask.note }}</span>
            <Notice v-if="notice" :of="notice" />
        </div>
    </div>
</template>
