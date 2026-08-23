<!-- THE PEOPLE THIS SANDBOX CAN BE, as a list you talk to: the chat list's other cut (chatGrouping.ts holds
     the switch). Where the lanes answer "what needs me next", this answers "who am I talking to", and a row
     here is a PERSONA rather than a session: Work, the Inbox Manager, whoever the workspace has cards for.

     WHY IT IS NOT SESSIONS GROUPED UNDER PERSONA HEADINGS, which is what this was first built as. A chat's
     persona is a composer pick that defaults to none, so on a real workspace every session sits in one "Anyone"
     pile and the grouping is a heading change and nothing else: 56 chats under one heading was the actual
     result. Grouping can only ever reflect a habit the product never asked anyone to form. A LIST OF PERSONAS
     needs no such habit: the cards exist because someone made them, and the rail is useful from the first one.

     PRESSING A ROW PUTS YOU IN A CHAT AS THAT PERSONA. If this window already holds one acting as them, it is
     the one that comes up: the most recent, because that is the conversation you were having. Otherwise a
     fresh chat opens already pinned to them, through the app's one "new agent" action so the caret lands in
     the composer exactly as it does everywhere else. So the rail reads as a correspondent list even though
     nothing behind it is stored per person: it is the persona card plus the chats that name it.

     IT IS A LIST OF PEOPLE AND NOTHING ELSE. There is no "Anyone" row: the composer's picker has one because
     there it means "send this turn through every account rather than one person's", but as a row HERE it meant
     every chat nobody had pinned, which on a real workspace is nearly all of them. It sat at the bottom
     holding eleven conversations and wearing their attention bar, outweighing the personas the list exists to
     show. Unpinned chats already have a home, and it is the Agents cut.

     IT OPENS ON WHOEVER YOU ARE ALREADY TALKING TO. If the chat you walk in from is pinned to a persona, that
     row is ringed and its group is already open on that chat: the list answers "where am I" before you press
     anything, which is the one thing a switcher must never make you work out for yourself. Walking in from an
     UNPINNED chat rings nobody, because there is nobody to ring. After that the ring is this list's own
     (`picked`), and walking back out leaves the Agents cut on the conversation it was already reading.

     WITH NO CARDS AT ALL the rail says what a persona is and offers the way to make one. A mode whose whole
     subject is personas, on a workspace with none, has to explain itself. -->
<script setup lang="ts">
import { personaBounds } from "@intentic/sandbox-contract";
import { ui, Icon, type IconName, PersonaFace, StatusBadge } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { startAgent } from "../composables/agents/agentActions";
import { agentStatusMeta, blocked, type FleetLane } from "../composables/agents/agentStatus";
import { type FleetAgent, useAgents } from "../composables/agents/useAgents";
import { relativeTime, statusIcon } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { laneOfTab, tabLabel } from "../composables/chat/tabs";
import { useChat } from "../composables/chat/useChat";
import { usePersonas } from "../composables/sandbox/usePersonas";
import RailCard from "../components/RailCard.vue";

// The host focuses the chat, exactly as it does for the lanes' rows: this list emits verbs and never writes
// the store itself.
const emit = defineEmits<{ select: [id: string] }>();

const { personas } = usePersonas();
const { activeId, conversations } = useChat();
const { agentById } = useAgents();

/* WHAT THIS WINDOW IS HOLDING FOR EACH PERSONA. The pick lives on the conversation (Conversation.actsAs) and
 * nowhere else: the sandbox files it against each turn, never against the session, so the chats a row can
 * speak for are this window's own tabs. That is a real limit and the row is careful never to imply otherwise:
 * it reports what it can see ("2 chats", when they last moved) and claims nothing about the rest. */
const chatsOf = (id: string) =>
    conversations.value
        .filter((conversation) => conversation.actsAs.value === id)
        .map((conversation) => ({ conversation, agent: agentById(conversation.conversationId) }))
        .toSorted((a, b) => (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0));

/* THE CHAT THIS RAIL IS RINGING: the one it put on screen itself, or the one you arrived holding.
 *
 * SEEDED ONCE, AT THE MOMENT THE COLUMN BECOMES THIS LIST (the host mounts the rail on the switch, so setup IS
 * the switch), from the window's focused chat and only when that chat NAMES A PERSONA. Without the seed, going
 * to the Agents cut and back left you looking at the very conversation you were in with nobody ringed for it:
 * the list disowning a chat that is, by its own rule, one of this persona's. A pinned chat is a fact about
 * the chat, not a claim about what you pressed here, so the list can state it on arrival without inventing
 * anything.
 *
 * AND ONLY ON ARRIVAL, never as a live mirror of the focus. Whatever moves the chat while this column is up:
 * a pane, a keyboard cycle, a turn landing somewhere else: must not drag the ring around a list you are
 * reading: one is a list of work and the other a list of people, and they are not one selection drawn twice.
 * A plain ref, so it starts from the arrival state every time the switch remounts the rail. */
const arrivedIn = conversations.value.find(
    (conversation) => conversation.conversationId === activeId.value && conversation.actsAs.value !== undefined,
);
const arrivedAs = arrivedIn?.actsAs.value;
const picked = ref<string | undefined>(arrivedIn?.conversationId);

interface PersonaRow {
    readonly key: string;
    readonly id: string;
    readonly label: string;
    readonly accounts: number;
    readonly bounds: string | undefined;
    readonly chats: number;
    readonly lastAt: number | undefined;
    readonly needsYou: boolean;
    readonly open: boolean;
}

/* ONE ROW PER PERSONA CARD, and nothing else on the list.
 *
 * THERE IS NO "ANYONE" ROW. It was here because the composer's picker has one, where it means something
 * precise: "send this turn through every account rather than one person's". As a row in a list of PEOPLE it
 * meant something else entirely: every chat that had never been pinned, which on a real workspace is almost
 * all of them. So it sat at the bottom holding eleven conversations, wearing their attention bar, outweighing
 * the personas the list exists to show, and answering a question nobody asked it. Unpinned chats already have
 * a home: the Agents cut, which is the whole list of them. */
const rows = computed<PersonaRow[]>(() =>
    personas.value.map((persona) => {
        const mine = chatsOf(persona.id);
        return {
            key: persona.id,
            id: persona.id,
            label: persona.label ?? persona.id,
            accounts: persona.capabilities.length,
            bounds: persona.powers === undefined ? undefined : personaBounds(persona),
            chats: mine.length,
            lastAt: mine[0]?.agent?.updatedAt,
            // The bar down the row's edge, on the same channel a session card uses: one of this persona's chats
            // is waiting on you, which is the only thing here worth interrupting a scan for.
            needsYou: mine.some((entry) => entry.agent !== undefined && blocked(entry.agent)),
            // Ringed only for a chat opened FROM HERE: see `picked`.
            open: mine.some((entry) => entry.conversation.conversationId === picked.value),
        };
    }),
);

const empty = computed(() => personas.value.length === 0);

/* THE PRESS. The most recent chat already acting as them, or a new one pinned to them: see the note at the
 * top for why those are the same act from the reader's side ("put me in a chat with this persona"). */
const open = (row: PersonaRow): void => {
    const first = chatsOf(row.id)[0];
    picked.value = first === undefined ? startAgent(undefined, row.id) : first.conversation.conversationId;
    if (first !== undefined) {
        emit(`select`, first.conversation.conversationId);
    }
};

// Switching to one of a persona's other chats, and starting a fresh one, both land here: the ring follows
// what this rail put on screen either way.
const show = (conversationId: string): void => {
    picked.value = conversationId;
    emit(`select`, conversationId);
};
const startAs = (row: PersonaRow): void => {
    picked.value = startAgent(undefined, row.id);
};

/* --- The persona's other chats ---------------------------------------------------------------------------
 * A ROW USED TO STATE A NUMBER IT WOULD NOT OPEN. "6 chats" named six conversations and the only press on the
 * card went to the newest of them, so the other five were reachable only by leaving this cut for the Agents
 * one, which is to say, by giving up the persona you were looking at. A count that cannot be opened is worse
 * than no count.
 *
 * AND THERE WAS NO WAY TO START A SECOND. The card's press means "the latest, or a new one if there are none",
 * so the moment a persona had one chat the rail could never make another: you had to press New agent and then
 * name the persona by hand in the composer, which is the errand this whole list exists to remove. Both of
 * those are one disclosure: the chats appear, and the way to make the next one appears under them.
 *
 * IT OPENS FROM THE COUNT, not from the card. The card's press is the fast path ("talk to them") and it stays
 * one press; the disclosure is its own smaller target beside it. Offered from ONE chat rather than two: with
 * one there is nothing to choose between, but there is still a second chat to start. */
/* The persona you ARRIVED inside is open from the first frame, for the same reason its row is ringed: the chat
 * being highlighted is a row in that group, and a group shut over it would be pointing at something the reader
 * cannot see. Seeded rather than left to the watch below, which fires on CHANGE and so has nothing to say
 * about the state the list mounted in. */
const expanded = ref<Set<string>>(new Set(arrivedAs === undefined ? [] : [arrivedAs]));
const isExpanded = (row: PersonaRow): boolean => expanded.value.has(row.key);
const toggleExpanded = (row: PersonaRow): void => {
    const next = new Set(expanded.value);
    if (!next.delete(row.key)) {
        next.add(row.key);
    }
    expanded.value = next;
};

/* The persona you have OPENED FROM HERE expands itself, so the rail shows where the press landed rather than
 * making you find it. Keyed to this rail's own pick, not to the window's active chat: once the list is up, a
 * chat focused from somewhere else must not fling a group open under the reader. Fires only when that pick
 * changes: a reader who then collapses it has said something, and it must not spring back open. */
watch(
    () => rows.value.find((row) => row.open)?.key,
    (key) => {
        if (key !== undefined && !expanded.value.has(key)) {
            expanded.value = new Set(expanded.value).add(key);
        }
    },
);

/* INSIDE A GROUP: what needs you, then what is running, then what finished, newest first within each, the
 * order every other list of sessions in this app uses. Grouping by person must not cost the routing. */
const LANE_RANK: Record<FleetLane, number> = { attention: 0, active: 1, finished: 2 };
const sessionsOf = (row: PersonaRow) =>
    chatsOf(row.id).toSorted(
        (a, b) =>
            LANE_RANK[laneOfTab(a.conversation, a.agent)] - LANE_RANK[laneOfTab(b.conversation, b.agent)] ||
            (b.agent?.updatedAt ?? 0) - (a.agent?.updatedAt ?? 0),
    );

// The status glyph, in the shape RailCard binds onto an Icon: the agent's own machine where there is one
// (landed, conflict…), and what the conversation is doing where there isn't.
const statusOf = (entry: { conversation: Conversation; agent: FleetAgent | undefined }): { name: IconName; spin?: boolean; class: string } => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { name: meta.icon, spin: meta.spin, class: `text-xs ${meta.class}` };
    }
    const icon = statusIcon(entry.conversation.status.value);
    return { name: icon.name, spin: icon.spin, class: `text-xs ${icon.class}` };
};
</script>

<template>
    <div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        <template v-if="empty">
            <!-- A place, so it is a link: the sandbox hub has an address, and this tile is often the first
                 time somebody goes looking for it. -->
            <RouterLink to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                <Icon name="plus" class="text-2xs" />
                Set up a persona
            </RouterLink>
        </template>

        <template v-else>
            <template v-for="row in rows" :key="row.key">
                <RailCard :title="row.label" :selected="row.open" :attention="row.needsYou" :aria-label="`Chat as ${row.label}`" class="persona-rail-card" @click="open(row)">
                    <!-- THE FACE, at the card's own height rather than at a glyph's. This list is scanned for a
                     PERSON, and a name is what you read second, so the mark leads, big enough to be found
                     without reading, and the row's text sits beside it. Generated from the persona's id, so
                     it is the same face here, in the composer's picker and on the personas page. -->
                    <template #aside>
                        <!-- NO SIZE HERE, which is deliberate: the face's own default is this list size, and
                             the personas page asks for it the same way, so the two cannot drift apart the way a
                             hand-written 56 here and a 32 there did. It is a fixed number rather than a share of
                             the card because it is what SETS the row's height: a face this size is taller than
                             the two lines of text beside it, so the card is as tall as its mark and every row in
                             the column matches. Sizing it from the card instead (`h-full`) reads as the tidier
                             idea and resolves its percentage against a box that is itself waiting on the mark to
                             know how tall it is.
                             The row satisfies the face's persona shape on its own: it carries the id and the
                             resolved label, so nothing here re-states what a persona's face is made of. -->
                        <PersonaFace :persona="row" />
                    </template>
                    <!-- The clock, where the rail's session rows keep theirs. Only once this persona has a chat to
                     have a clock about. It rides the TITLE's line, so gaining one never changes the row's
                     height: see the meta line below for the other half of that. -->
                    <template #trailing>
                        <span v-if="row.lastAt !== undefined && row.lastAt > 0" class="shrink-0 text-2xs text-subtle">{{
                            relativeTime(row.lastAt)
                        }}</span>
                    </template>
                    <!-- ONE LINE, ALWAYS, AND NEVER WRAPPING: a stability rule rather than a layout preference.
                     Pressing a row opens a chat as that persona, which is the moment the row gains a count and
                     a clock; when those arrived as separate children of a wrapping line they pushed onto a
                     second row, the card grew by a line, and the list jumped under the cursor that had just
                     clicked it. So everything the line says is composed into a SINGLE child: a flex row with
                     nothing for the parent to wrap, holding its height whether it is full or empty. -->
                    <template #meta>
                        <span class="flex min-h-4 min-w-0 flex-1 items-center gap-2 overflow-hidden">
                            <StatusBadge v-if="row.bounds !== undefined" variant="neutral" size="xs">{{ row.bounds }}</StatusBadge>
                            <!-- The account count, when there are any. A persona with none says nothing here
                             rather than apologising for itself. Shown as a count rather than the raw ids,
                             because the ids are internal slugs that read as noise on a list of people. -->
                            <span v-if="row.accounts > 0" class="min-w-0 truncate text-subtle">{{ row.accounts }} account{{ row.accounts === 1 ? `` : `s` }}</span>
                            <!-- What this window is holding for them, stated as what it is: the chats open HERE:
                             and the door to them. Absent at zero, where "0 chats" would only be saying that a
                             fresh persona is fresh, and where the card's own press already starts one.
                             `role="button"` rather than a nested <button>, which the card's own button element
                             cannot legally contain; `.stop` so opening the list is not also opening the chat. -->
                            <span
                                v-if="row.chats > 0"
                                role="button"
                                :aria-expanded="isExpanded(row)"
                                :aria-label="`Show ${row.label}'s chats`"
                                class="-my-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-muted transition-colors hover:bg-overlay hover:text-content"
                                @click.stop="toggleExpanded(row)"
                            >
                                {{ row.chats }} chat{{ row.chats === 1 ? `` : `s` }}
                                <Icon :name="isExpanded(row) ? `chevron-up` : `chevron-down`" class="text-2xs" />
                            </span>
                        </span>
                    </template>
                </RailCard>

                <!-- THE PERSONA'S OWN CHATS, indented under them. The board's card at rail width, exactly as the
                 Agents cut draws it: these are the same conversations, so nothing here is a new thing to
                 learn. Only the facts a one-line row can carry: which one it is, what it is doing, and when. -->
                <!-- The INDENT is on the group, never on the cards: a card is `w-full`, so a margin on each one
                     adds to a width that was already the column's and pushes the whole run off the rail's right
                     edge. Indenting their container narrows them instead. -->
                <div v-if="isExpanded(row)" class="ml-5 flex min-w-0 flex-col gap-1.5">
                    <RailCard
                        v-for="entry in sessionsOf(row)"
                        :key="entry.conversation.conversationId"
                        :title="tabLabel(entry.conversation)"
                        :provider="entry.agent?.provider ?? entry.conversation.provider.value"
                        :status="statusOf(entry)"
                        :selected="entry.conversation.conversationId === picked"
                        :attention="entry.agent !== undefined && blocked(entry.agent)"
                        :aria-label="`Open ${tabLabel(entry.conversation)}`"
                        @click="show(entry.conversation.conversationId)"
                    >
                        <template #trailing>
                            <span v-if="entry.agent !== undefined && entry.agent.updatedAt > 0" class="shrink-0 text-2xs text-subtle">{{
                                relativeTime(entry.agent.updatedAt)
                            }}</span>
                        </template>
                    </RailCard>
                    <!-- THE SEVENTH CHAT. Without this the rail can open a persona's existing conversations and
                     still not make another one: the gap the disclosure exists to close as much as switching
                     is. It sits under them because that is the order the question arrives in: none of these,
                     then a new one. -->
                    <button type="button" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)" @click="startAs(row)">
                        <Icon name="plus" class="text-2xs" />
                        New chat as {{ row.label }}
                    </button>
                </div>
            </template>

            <!-- The way to the page that owns these cards, at the bottom where a list's "manage" always is:
                 the picker in the composer puts it in the same place. -->
            <RouterLink to="/sandbox/personas" :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)">
                <Icon name="cog" class="text-2xs" />
                Manage personas
            </RouterLink>
        </template>
    </div>
</template>

<style scoped>
/* PERSONA CARDS HAVE NO LANE UNDER THEM, and that is the whole reason they read as flat rectangles rather than
 * as objects. Every other list of session cards in the app sits on a `.lane` slab, and the slab is what does the
 * work: a card is a step LIGHTER than the ground beneath it, so the ground is what makes the card visible (see
 * the note on `.lane` in styles.css, which states that contract outright). These rows float directly on the
 * rail's canvas, so the card has nothing to be a step lighter THAN.
 *
 * The default fill cannot close that on its own, because `--color-card` is not a colour this app chooses: it is
 * mapped from the host theme's `sideBar.background`, and a great many themes set that to exactly the editor
 * background. When they do, the fill EQUALS the canvas and the border is the only thing left of the card, which
 * is the "transparent card" this rule exists to answer.
 *
 * So the fill is MIXED FROM THE INK INTO THE GROUND rather than named as a token — the same formula `.lane` uses,
 * and for the same stated reason: a percentage of content over canvas is guaranteed to land off the canvas in
 * both schemes, whatever the host theme did or did not provide. Six percent sits a step above the lane's three,
 * which is where a card belongs relative to a slab; hover adds four more.
 *
 * ONLY THE UNSELECTED ROWS, which is not a nicety. A scoped style in a single-file component is UNLAYERED, and
 * unlayered rules beat every rule in a layer no matter how specific — `.session-card` and all of its states live
 * in `@layer components`. Without the `:not()` these two lines would silently outrank
 * `.session-card.session-card-on` and repaint the selected persona's accent border grey, which is the one card in
 * the list whose edge is carrying information. Excluded here, the selected row keeps its own fill, border, ring
 * and lift untouched, and the border under the pointer still strengthens from the layered hover rule. */
.persona-rail-card:not(.session-card-on) {
    --card-fill: color-mix(in srgb, var(--color-content) 6%, var(--color-canvas));
}
.persona-rail-card:not(.session-card-on):hover {
    --card-fill: color-mix(in srgb, var(--color-content) 10%, var(--color-canvas));
}
</style>
