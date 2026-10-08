<script setup lang="ts">
import type { AgentReply, ChildMove, ChildRun } from "@intentic/sandbox-contract";
import { ContextMenu } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { providerDisplayLabel } from "../../accounts/providerCatalog";
import { type CardAnswer, SKIP_CALL } from "../../session/cardReplies";
import ChatCommandBlock from "../../tools/ChatCommandBlock.vue";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatChildAgentAsk from "./ChatChildAgentAsk.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { permissionStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.permission!);

// The child-agent gate's request carries the child it is about; every other permission ask carries none.
const child = computed(() => card.value.child);
const pending = computed(() => card.value.status === `pending`);
// The owner's pick for a start, held here until the allow carries it; a settled card reads what started off its own row.
const staged = ref<ChildRun | undefined>(undefined);
const livePick = computed(() => (pending.value ? staged.value : undefined));

// A child-agent ask names its move in the header and on the allow, as the daemon's own title does.
const childTitle = (move: ChildMove, provider: string): string => {
    switch (move) {
        case `spawn`:
            return t(`chat.chatChildAgentAsk.spawnTitle`, { provider });
        case `send`:
            return t(`chat.chatChildAgentAsk.sendTitle`, { provider });
        case `answer`:
            return t(`chat.chatChildAgentAsk.answerTitle`, { provider });
    }
};
const childVerb = (move: ChildMove): string => {
    switch (move) {
        case `spawn`:
            return t(`chat.chatChildAgentAsk.spawn`);
        case `send`:
            return t(`chat.chatChildAgentAsk.send`);
        case `answer`:
            return t(`chat.chatChildAgentAsk.answer`);
    }
};

// Header: the bridge's rendered prompt sentence, else a short noun phrase, else the bare tool name. A child-agent ask is
// titled here instead, off the provider that would actually run, which the owner may just have changed.
const title = computed(() => {
    const about = child.value;
    if (about !== undefined) {
        return childTitle(about.move, providerDisplayLabel((livePick.value ?? about).provider));
    }
    return card.value.title ?? card.value.displayName ?? card.value.toolName;
});
const allowLabel = computed(() => (child.value === undefined ? t(`chat.chatMessageView.allowOnce`) : childVerb(child.value.move)));

// Command disclosure, closed by default, per-decision only: the card's title already states the safety judgment.
const commandOpen = ref(false);
// The judge's sentence when it adds to the title, else the runtime's own description; one line with the command's pill.
const sentence = computed(() => card.value.explain ?? card.value.description);
// The pill previews the program's first line, so a settled card says what ran without being opened.
const commandHead = computed(() => card.value.program?.text.split(`\n`).find((line) => line.trim() !== ``)?.trim());
const toggleCommand = (): void => {
    commandOpen.value = !commandOpen.value;
};
// The sentence opens the command too, but not under a hand selecting words in it to copy.
const toggleFromSentence = (): void => {
    if (card.value.program !== undefined && (window.getSelection()?.toString() ?? ``) === ``) {
        toggleCommand();
    }
};

type Allowing = Exclude<Extract<AgentReply, { kind: `permission` }>[`decision`], `deny`>;

// Allowing a start carries the owner's pick with it, when there is one; the daemon starts the child on that instead.
const allow = (decision: Allowing = `once`): Promise<void> => {
    const pick = livePick.value;
    return props.reply(pick === undefined ? { kind: `permission`, decision } : { kind: `permission`, decision, child: pick });
};

// THE ALLOW MENU. Allow once stays the one-press default; the wider yeses fold behind its caret, narrowest first: what
// this card's own gate can remember (a rule, a tool, a secret, installs), then everything in this conversation. A card
// that always asks (a hard rule, a restart other conversations feel, an owner-only change) offers no "everything",
// since no standing yes would answer it. Each row answers at once: picking a scope is the decision, not a setting.
const menu = ref<{ show: (event: Event) => void }>();
const wider = computed<MenuItem[]>(() => [
    ...(card.value.alwaysLabel === undefined ? [] : [{ label: card.value.alwaysLabel, icon: `lock`, command: () => void allow(`always`) }]),
    ...(card.value.alwaysAsks === true
        ? []
        : [
              {
                  label: t(`chat.chatMessageView.allowEverything`),
                  icon: `bolt`,
                  hint: t(`chat.chatMessageView.allowEverythingHint`),
                  command: () => void allow(`everything`),
              },
          ]),
]);
const allowItems = computed<MenuItem[]>(() => [
    { label: allowLabel.value, icon: `check`, hint: t(`chat.chatMessageView.allowOnceHint`), command: () => void allow() },
    { separator: true },
    ...wider.value,
]);
</script>

<template>
    <!-- The safety judge's own verdict sentence on this program, never from the gated agent's own words; wraps in full. -->
    <ChatCard icon="shield" prose :title="title" :status="permissionStatus(card)">
        <div class="chat-card-body flex flex-col gap-2">
            <ChatChildAgentAsk
                v-if="child"
                :ask="child"
                :staged="livePick"
                :repointable="pending && child.move === `spawn`"
                :disabled="settling"
                @repoint="staged = $event"
            />

            <!-- One line: the sentence (shown only when it adds to the title: a hard-rule consequence, a machine name) on the
                 left, the command's pill on the right. Click-to-reveal, not a hover, so the command stays reachable on touch
                 and keyboard; the pill is the control, and a press on the sentence opens it too. -->
            <!-- Wraps rather than squeezes: in a narrow pane the pill drops under the sentence instead of folding it into a column. -->
            <div v-if="sentence || card.program" class="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <span
                    v-if="sentence"
                    class="min-w-0 grow basis-64 text-xs leading-relaxed text-content/85"
                    :class="card.program && `cursor-pointer transition-colors hover:text-content`"
                    data-permission-sentence
                    @click="toggleFromSentence"
                    >{{ sentence }}</span
                >
                <button
                    v-if="card.program"
                    type="button"
                    class="mt-px inline-flex max-w-[min(18rem,100%)] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs transition-colors focus-visible:ring-2 focus-visible:ring-primary-500/25 focus-visible:outline-none"
                    :class="
                        commandOpen
                            ? `border-line-strong bg-content/8 text-content`
                            : `border-line text-muted hover:border-line-strong hover:text-content`
                    "
                    :aria-expanded="commandOpen"
                    :aria-label="commandOpen ? t(`chat.chatMessageView.hideCommand`) : t(`chat.chatMessageView.showCommand`)"
                    data-command-pill
                    @click="toggleCommand"
                >
                    <Icon name="terminal" class="shrink-0 text-2xs text-subtle" />
                    <span class="min-w-0 truncate font-mono">{{ commandHead ?? t(`chat.chatMessageView.showCommand`) }}</span>
                    <Icon :name="commandOpen ? 'chevron-up' : 'chevron-down'" class="shrink-0 text-2xs" />
                </button>
            </div>
            <ChatCommandBlock v-if="card.program && commandOpen" :program="card.program" />

            <span v-if="card.path" class="font-mono text-2xs leading-snug text-subtle">{{ card.path }}</span>
            <span v-if="card.reason" class="text-2xs leading-snug text-subtle">{{
                t(`chat.chatMessageView.requestedBecause`, { reason: card.reason })
            }}</span>
        </div>

        <template v-if="pending" #actions>
            <!-- One split control: the press is Allow once, the caret opens every wider yes this card can take. -->
            <span class="inline-flex items-stretch gap-px">
                <ChatDecisionButton
                    tone="primary"
                    icon="check"
                    :class="wider.length > 0 && `rounded-r-none`"
                    :disabled="settling"
                    @click="allow()"
                    >{{ allowLabel }}</ChatDecisionButton
                >
                <ChatDecisionButton
                    v-if="wider.length > 0"
                    tone="primary"
                    class="rounded-l-none !px-1.5"
                    :disabled="settling"
                    :aria-label="t(`chat.chatMessageView.allowMore`)"
                    aria-haspopup="menu"
                    @click="menu?.show($event)"
                >
                    <Icon name="chevron-down" class="text-2xs" />
                </ChatDecisionButton>
            </span>
            <ContextMenu v-if="wider.length > 0" ref="menu" :model="allowItems" :min-width="16" />
            <!-- A refusal of this one call that lets the turn go on: the agent is told to carry on another way, or without it. Its
                 label says so, so it carries no hover of its own. -->
            <ChatDecisionButton tone="secondary" icon="forward" :disabled="settling" @click="reply(SKIP_CALL)">{{
                t(`chat.chatMessageView.skipCall`)
            }}</ChatDecisionButton>
            <!-- Like the question card's Dismiss: a refusal with no redirect ends the turn. -->
            <ChatDecisionButton
                tone="secondary"
                icon="times"
                :disabled="settling"
                v-tooltip.bottom="t(`chat.words.stopsTurn`)"
                @click="reply({ kind: 'permission', decision: 'deny' })"
                >{{ t(`ui.action.no`) }}</ChatDecisionButton
            >
        </template>
    </ChatCard>
</template>
