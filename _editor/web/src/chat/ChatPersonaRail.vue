<!-- THE PEOPLE THIS SANDBOX CAN BE, as a list you talk to — the chat list's other cut (chatGrouping.ts holds
     the switch). Where the lanes answer "what needs me next", this answers "who am I talking to", and a row
     here is a PERSONA rather than a session: Work, the Inbox Manager, whoever the workspace has cards for.

     WHY IT IS NOT SESSIONS GROUPED UNDER PERSONA HEADINGS, which is what this was first built as. A chat's
     persona is a composer pick that defaults to none, so on a real workspace every session sits in one "Anyone"
     pile and the grouping is a heading change and nothing else — 56 chats under one heading was the actual
     result. Grouping can only ever reflect a habit the product never asked anyone to form. A LIST OF PERSONAS
     needs no such habit: the cards exist because someone made them, and the rail is useful from the first one.

     PRESSING A ROW PUTS YOU IN A CHAT AS THAT PERSONA. If this window already holds one acting as them, it is
     the one that comes up — the most recent, because that is the conversation you were having. Otherwise a
     fresh chat opens already pinned to them, through the app's one "new agent" action so the caret lands in
     the composer exactly as it does everywhere else. So the rail reads as a correspondent list even though
     nothing behind it is stored per person: it is the persona card plus the chats that name it.

     ANYONE IS A ROW, last, and it is not the absence of a pick — a chat bound to nobody keeps every connected
     account, which is a different and more powerful thing than any single card. The composer's own picker
     makes exactly this call, in those words.

     WITH NO CARDS AT ALL the rail says so and offers the way to make one, rather than showing a lone "Anyone"
     row. A mode whose whole subject is personas, on a workspace with none, has to explain itself — a list of
     one unexplained row is how this feature first shipped, and it read as broken. -->
<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { Avatar, cmp, Icon, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { blocked } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";
import { identityHue } from "../composables/identityHue";
import { usePersonas } from "../composables/sandbox/usePersonas";
import RailCard from "../components/RailCard.vue";

// The host focuses the chat, exactly as it does for the lanes' rows — this list emits verbs and never writes
// the store itself.
const emit = defineEmits<{ select: [id: string] }>();

const router = useRouter();
const { personas, isConnected } = usePersonas();
const { conversations, activeId } = useChat();
const { agentById } = useAgents();

/* WHAT THIS WINDOW IS HOLDING FOR EACH PERSONA. The pick lives on the conversation (Conversation.actsAs) and
 * nowhere else — the sandbox files it against each turn, never against the session — so the chats a row can
 * speak for are this window's own tabs. That is a real limit and the row is careful never to imply otherwise:
 * it reports what it can see ("2 chats", when they last moved) and claims nothing about the rest. */
const chatsOf = (id: string | undefined) =>
    conversations.value
        .filter((conversation) => conversation.actsAs.value === id)
        .map((conversation) => ({ conversation, agent: agentById(conversation.conversationId) }))
        .toSorted((a, b) => (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0));

interface PersonaRow {
    readonly key: string;
    readonly id: string | undefined;
    readonly label: string;
    // The accounts under the name — a mark cannot tell `reddit-work` from `reddit-personal`, and those being
    // different accounts is the entire reason a persona exists.
    readonly detail: string;
    // A card naming no connected account can be talked to, but cannot post anywhere yet. Said in warning ink
    // rather than hidden, because a freshly cloned workspace is in exactly this state.
    readonly stranded: boolean;
    readonly bounds: string | undefined;
    readonly chats: number;
    readonly lastAt: number | undefined;
    readonly needsYou: boolean;
    readonly open: boolean;
}

const rowFor = (id: string | undefined, label: string, detail: string, stranded: boolean, bounds?: string): PersonaRow => {
    const mine = chatsOf(id);
    return {
        key: id ?? `anyone`,
        id,
        label,
        detail,
        stranded,
        bounds,
        chats: mine.length,
        lastAt: mine[0]?.agent?.updatedAt,
        // The bar down the row's edge, on the same channel a session card uses: one of this persona's chats is
        // waiting on you, which is the only thing here worth interrupting a scan for.
        needsYou: mine.some((entry) => entry.agent !== undefined && blocked(entry.agent)),
        // Whether the chat on screen right now is one of theirs — the rail's selection ring, so the row you are
        // talking through is the one wearing it.
        open: mine.some((entry) => entry.conversation.conversationId === activeId.value),
    };
};

const accountsOf = (persona: Persona): string => (persona.capabilities.length === 0 ? `No accounts yet` : persona.capabilities.join(` · `));
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

const rows = computed<PersonaRow[]>(() => [
    ...personas.value.map((persona) =>
        rowFor(
            persona.id,
            persona.label ?? persona.id,
            accountsOf(persona),
            !ready(persona),
            persona.powers === undefined ? undefined : personaBounds(persona),
        ),
    ),
    rowFor(undefined, `Anyone`, `Every account you've connected`, false),
]);

const empty = computed(() => personas.value.length === 0);

/* THE PRESS. The most recent chat already acting as them, or a new one pinned to them — see the note at the
 * top for why those are the same act from the reader's side ("put me in a chat with this persona"). */
const open = (row: PersonaRow): void => {
    const mine = chatsOf(row.id);
    const first = mine[0];
    if (first !== undefined) {
        emit(`select`, first.conversation.conversationId);
        return;
    }
    startAgent(undefined, row.id);
};

const managePersonas = (): void => void router.push(`/sandbox/personas`);
</script>

<template>
    <div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        <!-- Nothing set up is the ordinary state of a fresh workspace, not an error — so the empty rail says
             what a persona IS in one line, and offers the one press that makes this mode mean something. -->
        <template v-if="empty">
            <p class="px-1 pb-2 pt-3 text-2xs text-subtle">
                No personas yet. A persona is a name you can send as — a group of your connected accounts, so a chat can act as one person instead of
                reaching everything you own.
            </p>
            <button type="button" :class="cmp.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)" @click="managePersonas">
                <Icon name="plus" class="text-2xs" />
                Set up a persona
            </button>
        </template>

        <template v-else>
            <RailCard
                v-for="row in rows"
                :key="row.key"
                :title="row.label"
                :selected="row.open"
                :attention="row.needsYou"
                :aria-label="`Chat as ${row.label}`"
                @click="open(row)"
            >
                <!-- The persona's own mark, in the colour it wears on its own page and in the composer's
                     picker — keyed by id, so renaming somebody does not recolour a face you have learned. -->
                <template #lead>
                    <Avatar
                        v-if="row.id !== undefined"
                        :size="18"
                        :name="row.label"
                        :hue="identityHue(row.id)"
                        :idle="row.stranded"
                        class="mt-px shrink-0"
                    />
                    <span v-else class="mt-0.5 flex h-4 shrink-0 items-center"><Icon name="users" class="text-2xs text-subtle" /></span>
                </template>
                <!-- The clock, where the rail's session rows keep theirs. Only once this persona has a chat to
                     have a clock about. -->
                <template #trailing>
                    <span v-if="row.lastAt !== undefined && row.lastAt > 0" class="shrink-0 text-2xs text-subtle">{{
                        relativeTime(row.lastAt)
                    }}</span>
                </template>
                <template #meta>
                    <StatusBadge v-if="row.bounds !== undefined" variant="neutral" size="xs">{{ row.bounds }}</StatusBadge>
                    <span class="min-w-0 truncate" :class="row.stranded ? 'text-warning' : 'text-subtle'">
                        {{ row.detail }}<template v-if="row.stranded"> — not signed in yet</template>
                    </span>
                    <!-- What this window is holding for them, stated as what it is: the chats open HERE. Absent
                         at zero, where "0 chats" would only be saying that a fresh persona is fresh. -->
                    <span v-if="row.chats > 0" class="shrink-0">{{ row.chats }} chat{{ row.chats === 1 ? `` : `s` }}</span>
                </template>
            </RailCard>

            <!-- The way to the page that owns these cards, at the bottom where a list's "manage" always is —
                 the picker in the composer puts it in the same place. -->
            <button type="button" :class="cmp.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)" @click="managePersonas">
                <Icon name="cog" class="text-2xs" />
                Manage personas
            </button>
        </template>
    </div>
</template>
