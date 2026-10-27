<!-- How a closed need ended, in one line under its title: only what the title and its chip do not already say. Who
     answered when it was not the reader, their word back on a decline, the settings a change moved, the name a new
     connection took, a grant that went to the persona, what the agent saw when it closed one on its own word, and the one case worth a reader's attention: an agent that has not
     heard yet. The daemon's own sentence ("…now has the change applied") restates the chip, so it is said only where it
     carries the fact, and the agent's case folds behind a press. -->
<script setup lang="ts">
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatAgentCase from "../../components/card/ChatAgentCase.vue";
import ChatCardOutcome from "../../components/card/ChatCardOutcome.vue";
import ChatCardPerson from "../../components/card/ChatCardPerson.vue";
import { useSomeoneElse } from "../../components/card/cardPerson";
import { declineNote, unheardLine } from "../../models/needs/needStatus";
import NeedChangeFacts from "./NeedChangeFacts.vue";

const t = useT();

const { need } = defineProps<{ need: Need }>();

const someoneElse = useSomeoneElse();
const met = computed(() => need.status === `met`);
const subject = computed(() => need.subject);
const note = computed(() => declineNote(need));
// A no the daemon gave a reason for (what it was for went away) keeps that reason; a plain no says nothing past its chip.
const reason = computed(() => (need.status === `declined` && note.value === undefined && need.outcome ? need.outcome : undefined));
const change = computed(() => (met.value && subject.value.kind === `capability` && subject.value.mode === `change` ? subject.value : undefined));
// The one met sentence that names something the title cannot: the connection a new one was saved as.
const connected = computed(() => (met.value && subject.value.kind === `capability` && subject.value.mode === `connect` ? need.outcome : undefined));
// Closed by the agent (`needs done`) after a person said in the chat it was fixed: what its retry showed, since no
// person pressed anything on the card.
const byAgent = computed(() => (met.value && need.byAgent === true ? need.outcome : undefined));
const persona = computed(() =>
    met.value && subject.value.kind === `grant` && subject.value.scope === `persona` ? subject.value.persona : undefined,
);
const unheard = computed(() => unheardLine(need));
const facts = computed(
    () =>
        someoneElse(need.answeredBy) ||
        [note.value, reason.value, connected.value, byAgent.value, persona.value, unheard.value].some((fact) => fact !== undefined && fact !== ``) ||
        change.value !== undefined,
);
</script>

<template>
    <ChatCardOutcome :facts="facts" :more="need.why ? t(`chat.cardOutcome.why`) : undefined">
        <ChatCardPerson :who="need.answeredBy" />
        <q v-if="note" class="min-w-0 text-xs text-content/85" data-need-note>{{ note }}</q>
        <span v-if="reason" class="min-w-0">{{ reason }}</span>
        <NeedChangeFacts v-if="change" :subject="change" />
        <span v-if="connected" class="min-w-0">{{ connected }}</span>
        <span v-if="byAgent" class="min-w-0" data-need-by-agent>{{ byAgent }}</span>
        <span v-if="persona" class="min-w-0">{{ t(`needs.card.onPersona`, { persona }) }}</span>
        <span v-if="unheard" class="inline-flex min-w-0 items-center gap-1.5" data-need-unheard><Icon name="clock" class="shrink-0" />{{ unheard }}</span>
        <template #folded><ChatAgentCase v-if="need.why" :text="need.why" /></template>
    </ChatCardOutcome>
</template>
