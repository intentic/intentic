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
import { personaBounds } from "@intentic/sandbox-contract";
import { cmp, Icon, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { blocked } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";
import { usePersonas } from "../composables/sandbox/usePersonas";
import PersonaFace from "../components/PersonaFace.vue";
import RailCard from "../components/RailCard.vue";

// The host focuses the chat, exactly as it does for the lanes' rows — this list emits verbs and never writes
// the store itself.
const emit = defineEmits<{ select: [id: string] }>();

const router = useRouter();
const { personas } = usePersonas();
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
    /* The accounts under the name — a mark cannot tell `reddit-work` from `reddit-personal`, and those being
     * different accounts is the entire reason a persona exists.
     *
     * EMPTY WHEN THERE ARE NONE, rather than a line saying so. A persona holding no accounts is a perfectly
     * good persona: it still bounds what the chat can reach, it still names who is speaking, and it is
     * something you talk to on day one. This rail used to write "No accounts yet" in that slot and mark the
     * row, which turned the ordinary state of a new card into a defect on every row of the list. */
    readonly detail: string;
    readonly bounds: string | undefined;
    readonly chats: number;
    readonly lastAt: number | undefined;
    readonly needsYou: boolean;
    readonly open: boolean;
}

const rowFor = (id: string | undefined, label: string, detail: string, bounds?: string): PersonaRow => {
    const mine = chatsOf(id);
    return {
        key: id ?? `anyone`,
        id,
        label,
        detail,
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

const rows = computed<PersonaRow[]>(() => [
    ...personas.value.map((persona) =>
        rowFor(
            persona.id,
            persona.label ?? persona.id,
            persona.capabilities.join(` · `),
            persona.powers === undefined ? undefined : personaBounds(persona),
        ),
    ),
    rowFor(undefined, `Anyone`, `Every account you've connected`),
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
                <!-- THE FACE, at the card's own height rather than at a glyph's. This list is scanned for a
                     PERSON, and a name is what you read second — so the mark leads, big enough to be found
                     without reading, and the row's text sits beside it. Generated from the persona's id, so
                     it is the same face here, in the composer's picker and on the personas page. -->
                <template #aside>
                    <!-- ONE NUMBER FOR BOTH MARKS, and it is what sets the row's height: a face this size is
                         taller than the two lines of text beside it, so the card is as tall as its mark and
                         every row in the column matches. Sizing it from the card instead (`h-full`) reads as
                         the tidier idea and is not: the face and the Anyone glyph resolve their percentage
                         against slightly different boxes, so the column came out 44px next to 42px — a
                         mismatch you can see in a vertical list even when you cannot name it. -->
                    <PersonaFace v-if="row.id !== undefined" :seed="row.label" :size="44" />
                    <!-- Anyone is not a person and gets no invented face: the neutral glyph at that same size. -->
                    <span v-else class="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-line bg-content/5">
                        <Icon name="users" class="text-base text-muted" />
                    </span>
                </template>
                <!-- The clock, where the rail's session rows keep theirs. Only once this persona has a chat to
                     have a clock about. It rides the TITLE's line, so gaining one never changes the row's
                     height — see the meta line below for the other half of that. -->
                <template #trailing>
                    <span v-if="row.lastAt !== undefined && row.lastAt > 0" class="shrink-0 text-2xs text-subtle">{{
                        relativeTime(row.lastAt)
                    }}</span>
                </template>
                <!-- ONE LINE, ALWAYS, AND NEVER WRAPPING — a stability rule rather than a layout preference.
                     Pressing a row opens a chat as that persona, which is the moment the row gains a count and
                     a clock; when those arrived as separate children of a wrapping line they pushed onto a
                     second row, the card grew by a line, and the list jumped under the cursor that had just
                     clicked it. So everything the line says is composed into a SINGLE child: a flex row with
                     nothing for the parent to wrap, holding its height whether it is full or empty. -->
                <template #meta>
                    <span class="flex min-h-4 min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        <StatusBadge v-if="row.bounds !== undefined" variant="neutral" size="xs">{{ row.bounds }}</StatusBadge>
                        <!-- The accounts, when there are any. A persona with none says nothing here rather than
                             apologising for itself — see `detail`. -->
                        <span v-if="row.detail !== ``" class="min-w-0 truncate text-subtle">{{ row.detail }}</span>
                        <!-- What this window is holding for them, stated as what it is: the chats open HERE.
                             Absent at zero, where "0 chats" would only be saying that a fresh persona is fresh. -->
                        <span v-if="row.chats > 0" class="shrink-0">{{ row.chats }} chat{{ row.chats === 1 ? `` : `s` }}</span>
                    </span>
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
