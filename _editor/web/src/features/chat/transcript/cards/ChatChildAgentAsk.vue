<script setup lang="ts">
import type { ChildAgentAsk, ChildMove, ChildRun } from "@intentic/sandbox-contract/events/requests";
import { Markdown, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import ProviderLogo from "../../../../parts/providers/ProviderLogo.vue";
import { requestModelPick } from "../../../../models/conversations/accounts/hostModelPicker";
import { childRunFacts, childRunLine, childRunLook, childWordsGist, pickedChildRun } from "./childAgentRun";

// The child agent a held supervisor call is about, inside its permission card, under a title that already names its task
// (ChatPermissionCard). What is left reads as a sheet of quiet labels and clear values: what it runs on, and what it would
// be told. A start still waiting for its answer can be re-pointed from the Model value, through the same shell picker a Fix
// with agent caret opens; the card keeps the pick and sends it with the allow.
// The parent's words stay folded to one line (their section names, else their first line) and open in place as rendered
// markdown: read at the moment of deciding, three lines of a prompt's setup told the owner nothing.

const t = useT();

const {
    ask,
    staged = undefined,
    repointable = false,
    disabled = false,
    settled = false,
} = defineProps<{
    // The request's own account of the child, from the daemon's record of the call; once settled, what actually started.
    ask: ChildAgentAsk;
    // The owner's pick on a live card, when they made one; it is what starts if they allow.
    staged?: ChildRun | undefined;
    // Only a start still waiting can be re-pointed: a child already running keeps the run it was started on.
    repointable?: boolean;
    disabled?: boolean;
    // Answered: history under the subagent's own row, drawn in the quieter ink.
    settled?: boolean;
}>();
const emit = defineEmits<{ repoint: [run: ChildRun | undefined] }>();

const run = computed<ChildRun>(() => staged ?? ask);
const line = computed(() => childRunLine(run.value));
const look = computed(() => childRunLook(run.value));
const facts = computed(() => childRunFacts(ask, run.value));
// What the agent asked for, when that is not what starts: the owner's pick on a live card, the record's once settled.
const changedFrom = computed(() => {
    const asked = staged === undefined ? ask.proposed : ask;
    return asked === undefined ? undefined : childRunLine(asked);
});

// THE PARENT'S WORDS: a start's prompt, a message, or the answers it gives, named as the move names them.
const wordsLabel = (move: ChildMove): string => {
    switch (move) {
        case `spawn`:
            return t(`chat.chatChildAgentAsk.prompt`);
        case `send`:
            return t(`chat.chatChildAgentAsk.message`);
        case `answer`:
            return t(`chat.chatChildAgentAsk.answers`);
    }
};
const words = computed(() => (ask.message === undefined || ask.message === `` ? undefined : ask.message));
const gist = computed(() => childWordsGist(ask));
const open = ref(false);

// The value is the anchor the picker hangs off, as a run button's caret is.
const pick = ref<HTMLElement>();
const choose = async (): Promise<void> => {
    const anchor = pick.value;
    if (anchor === undefined) {
        return;
    }
    // The picker reads an absent knob and an undefined one alike (hostModelPicker.ts), so the run passes through whole.
    const { provider, model, account, harness, effort, thinking, fast } = run.value;
    const choice = await requestModelPick({
        anchor,
        provider,
        model,
        account,
        harness,
        effort,
        thinking,
        fast,
        // A child carries all three knobs to its turn (children.ts childProfile), so the picker offers them.
        chooseRun: true,
        action: t(`chat.chatChildAgentAsk.useForAgent`),
    });
    if (choice !== undefined) {
        emit(`repoint`, pickedChildRun(choice, ask));
    }
};
// The same element reads the run on a card that can no longer change it, where a press does nothing.
const press = (): void => {
    if (repointable) {
        void choose();
    }
};
</script>

<template>
    <div class="flex min-w-0 flex-col gap-2">
        <!-- Quiet label, clear value: the label column as wide as its longest word, the values on one edge. -->
        <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
            <dt class="text-2xs text-muted">{{ t(`shared.model`) }}</dt>
            <dd class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <!-- WHAT IT RUNS ON: the model and its tier on the composer's ladder. Pressable only while a start waits,
                     and then as a borderless value with a caret, washed on hover: a control, not another tinted box. -->
                <component
                    :is="repointable ? `button` : `span`"
                    ref="pick"
                    :type="repointable ? `button` : undefined"
                    class="flex max-w-full min-w-0 items-center gap-1.5 font-medium"
                    :class="[
                        repointable
                            ? `touch-target ui-off -mx-1.5 cursor-pointer rounded-md px-1.5 py-0.5 text-content transition-colors select-none hover:bg-overlay focus:outline-none focus-visible:bg-overlay disabled:cursor-default`
                            : settled
                              ? `text-muted`
                              : `text-content`,
                    ]"
                    :disabled="repointable ? disabled : undefined"
                    :aria-label="repointable ? t(`chat.chatChildAgentAsk.change`, { run: line }) : line"
                    v-tooltip.top="repointable ? { title: t(`chat.chatChildAgentAsk.changeRun`), note: t(`chat.chatChildAgentAsk.modelAccountEffort`) } : undefined"
                    :data-child-run-pick="repointable ? `` : undefined"
                    :data-child-run="repointable ? undefined : ``"
                    :data-picked="staged !== undefined ? `` : undefined"
                    @click="press"
                >
                    <ProviderLogo :provider="run.provider" class="shrink-0 text-link" />
                    <span class="truncate">{{ look.model }}</span>
                    <!-- The composer's ladder as a picture, small enough for a line of text: the same rungs, lit the same way. -->
                    <span v-if="look.rungs.length > 0" class="flex shrink-0 items-end gap-px" aria-hidden="true">
                        <span
                            v-for="(fill, index) in look.rungs"
                            :key="index"
                            class="h-2.5 w-0.75 rounded-xs"
                            :class="fill === undefined && `bg-content/15`"
                            :style="fill === undefined ? undefined : { backgroundColor: fill }"
                        ></span>
                    </span>
                    <span v-else-if="look.tier" class="shrink-0 font-normal text-muted">{{ look.tier }}</span>
                    <span v-if="look.fast" class="shrink-0 font-normal text-muted">{{ t(`chat.chatChildAgentAsk.fast`) }}</span>
                    <Icon v-if="repointable" name="chevron-down" class="shrink-0 text-4xs text-subtle" aria-hidden="true" />
                </component>
                <span v-for="fact in facts" :key="fact" class="flex items-center gap-2 text-2xs text-subtle">
                    <span aria-hidden="true">·</span>{{ fact }}
                </span>
            </dd>

            <template v-if="changedFrom">
                <dt class="sr-only">{{ t(`chat.chatChildAgentAsk.changedLabel`) }}</dt>
                <dd class="col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 text-2xs leading-snug text-muted">
                    <span>{{ t(`chat.chatChildAgentAsk.changedFrom`, { run: changedFrom }) }}</span>
                    <button
                        v-if="staged !== undefined"
                        type="button"
                        :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                        :disabled="disabled"
                        @click="emit(`repoint`, undefined)"
                    >
                        {{ t(`chat.chatChildAgentAsk.useAgentsPick`) }}
                    </button>
                </dd>
            </template>

            <!-- WHAT IT WOULD BE TOLD, in one line until opened: the press is the whole value, so the line opens it too. -->
            <template v-if="words">
                <dt class="text-2xs text-muted">{{ wordsLabel(ask.move) }}</dt>
                <!-- Pulled out by the press's own padding, so its words start on the values' edge and its wash reaches past it. -->
                <dd class="-mx-1.5 min-w-0">
                    <button
                        type="button"
                        class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-overlay focus:outline-none focus-visible:bg-overlay"
                        :aria-expanded="open"
                        data-child-message-toggle
                        @click="open = !open"
                    >
                        <span class="min-w-0 grow truncate" :class="settled ? `text-muted` : `text-content`" data-child-gist>{{ gist }}</span>
                        <span class="flex shrink-0 items-center gap-1 text-2xs text-muted">
                            {{ open ? t(`chat.chatChildAgentAsk.hide`) : t(`chat.chatChildAgentAsk.showAll`) }}
                            <Icon :name="open ? `chevron-up` : `chevron-down`" class="text-4xs" aria-hidden="true" />
                        </span>
                    </button>
                </dd>
            </template>
        </dl>

        <!-- Opened, the words read as the document they are, not as a quote of their source. -->
        <Markdown v-if="words && open" :source="words" class="chat-markdown chat-markdown-compact min-w-0 text-xs" data-child-message />
    </div>
</template>
