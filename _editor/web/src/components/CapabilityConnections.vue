<!-- WHAT YOU HAVE, as opposed to what you could have: the list behind the capabilities view's "Connected"
     slice.

     That slice used to be the catalog with the unconnected cards taken out, and a filtered catalog cannot answer
     the question it is opened with. A card is a KIND of thing ("SSH: operate a remote machine over SSH"); what
     somebody means by "what have I got connected" is the THINGS: ops-box at ops.acme.dev, the work Reddit and the
     personal one, the Postgres pointed at the shop database. Three connections of one card collapsed into one
     tile with a tick, none of them named, and the only way to read back a hostname you set months ago was to open
     the card and read it out of a form. So this lists instances, one row each.

     IT IS ALSO WHERE STATE BECOMES VISIBLE. A browser whose session expired, a machine that has not checked in, a
     capability waiting on a sandbox rebuild: all of that lived one click inside a card, which means the page
     that is supposed to say what your agent can reach could not say which parts of it are currently broken. Rows
     needing attention sort to the top of their group (the caller orders them), so the answer is the first thing
     in view rather than something to go hunting for.

     ROWS RATHER THAN TILES, deliberately. A tile is a thing you are choosing between; a row is a thing you own.
     The same swap the rest of the app already makes: the extension list, the memory index, the log files, and
     it is what lets a name, what it is, a hostname and a state sit on one scannable line.

     A ROW IS A WAY IN, not a control panel. It opens THIS CONNECTION on the card it came from: its own settings
     loaded, its own row highlighted in the list above them, which is where its form, its per-kind buttons (log
     in, connect, restart) and its removal already live. Duplicating any of those here would be a second copy of
     a flow that is one click away, and a button inside a button, which is neither valid nor reachable by
     keyboard.

     THE CONNECTION AND NOT MERELY ITS CARD, because the row is a connection: this list exists precisely because
     three SSH boxes are three things and one card, and landing on the card would drop the half of the answer the
     reader clicked on. It is also what makes "read back the hostname I set months ago" a click rather than an
     archaeology: the sentence at the top of this comment, finally true. -->

<script lang="ts">
import type { IconName, StatusVariant } from "@intentic/ui";

export interface CapabilityConnection {
    /** What this connection is called: the name its owner typed, or the card's own name where they never
     *  typed one (a one-per-sandbox card takes its id, and "docker" under a Docker logo is not a name). */
    readonly title: string;
    /** The card it came from: omitted where the title already IS the card, so no row says "docker / Docker". */
    readonly card?: string;
    /** Where the row leads. */
    readonly cardId: string;
    /** Distinguishes two rows that came from the same card and would otherwise share a key. */
    readonly id: string;
    readonly logo?: string;
    readonly icon: IconName;
    /** What tells this one apart from another of the same card: a host, an account, a database. May be empty. */
    readonly detail: string;
    /** The state in the reader's words ("ready", "offline", "needs sign-in"), and the tint it earns. */
    readonly state: string;
    readonly tone: StatusVariant;
    /** What is still missing, when something is: the daemon's own sentence, already written for a reader. */
    readonly note?: string;
    /** A code the owner has to type on another device to finish this one (WhatsApp's link-a-device code). It
     *  rides the row because the sentence beside it says "type this code", and a row that says that without
     *  showing one is a riddle; the card it leads to is where it is set big enough to transcribe from. */
    readonly code?: string;
}

export interface CapabilityConnectionGroup {
    readonly label: string;
    readonly rows: readonly CapabilityConnection[];
}
</script>

<script setup lang="ts">
import { BrandMark, Row, RowGroup, StatusBadge } from "@intentic/ui";

defineProps<{ groups: readonly CapabilityConnectionGroup[] }>();
const emit = defineEmits<{ open: [cardId: string, connectionId: string] }>();
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Grouped by category and counted, so this reads as the same page the catalog does: the rail points at
             the same ten headings either way. -->
        <RowGroup v-for="group in groups" :key="group.label" :label="group.label" :count="group.rows.length">
            <Row
                v-for="row in group.rows"
                :key="`${row.cardId}:${row.id}`"
                as="button"
                density="compact"
                chevron
                @click="emit(`open`, row.cardId, row.id)"
            >
                <template #lead>
                    <BrandMark :size="24" :name="row.title" :logo="row.logo" :icon="row.icon" />
                </template>
                <!-- THE NAME LEADS. It is the one word on the row its owner chose, and on a card holding several
                     connections it is the only thing that tells them apart. -->
                <template #title>{{ row.title }}</template>
                <!-- Conditional so a row with nothing left to say: a one-per-sandbox capability with no address
                     and nothing outstanding: doesn't reserve an empty second line and stand a head taller than
                     the rows around it. -->
                <template v-if="row.card !== undefined || row.detail !== `` || row.note !== undefined" #description>
                    <span v-if="row.card">{{ row.card }}</span>
                    <!-- Mono because it is an address, and addresses are compared character by character. -->
                    <span v-if="row.detail" class="font-mono text-subtle"><span v-if="row.card"> · </span>{{ row.detail }}</span>
                    <!-- Beside the facts rather than in place of them: what is missing does not stop the hostname
                         being the thing that identifies the row. -->
                    <span v-if="row.note" class="text-warning">
                        <span v-if="row.card || row.detail"> · </span>
                        <span v-if="row.code" class="font-mono font-semibold tracking-widest">{{ row.code }}</span>
                        <span v-if="row.code">: </span>{{ row.note }}
                    </span>
                </template>
                <template #meta>
                    <StatusBadge :variant="row.tone" size="xs" dot :label="row.state" />
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
