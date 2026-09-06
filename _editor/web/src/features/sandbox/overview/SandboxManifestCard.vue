<script setup lang="ts">
import { Button, DisclosureRow, Notice, RowGroup, StatusBadge } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { useManifestProblems } from "../extensions/useManifestProblems";
import { openWorkspaceRef } from "../../workspace/files/openFileRef";
import { type ManifestRepairAction, manifestNotices } from "./manifestNotice";

/* "Something in your settings files isn't being read": the companion to SandboxBehindCard.
 *
 * That card is about a mismatch between this app and the sandbox's build. This one is about the sandbox's own
 * state files: it read them, something in them didn't make sense, and it carried on with defaults. Both are
 * non-blocking notices about a thing that is quietly not working, which is why they sit together; they are
 * separate cards because the remedies have nothing in common: one is "update the sandbox", the other is
 * "there's a typo on line 12".
 *
 * A FILE IS A LINE. Not a paragraph, which is what this was: a three-sentence preamble explaining that settings
 * files exist and get read, a "1 to fix" badge counting a list that was right there, then the path, then a
 * sentence per problem running cause, hypothesis and two instructions together. For ONE misspelled key. Nobody
 * reads that; they see a block of amber text and scroll past, which is the worst outcome available to a notice.
 *
 * So a collapsed row is a NAME and a TAG — `settings.json` · `using defaults` — and that is the entire default
 * state of this card. Three broken files is three lines. The diagnosis and the instruction sit behind the row's
 * own chevron, where they cost nothing until somebody wants them, which is the right price for detail about a
 * config file that is, at worst, quietly using defaults.
 *
 *   • THE NAME, NOT THE PATH. All of these live in `.intentic/config/` (REPORTED_MANIFEST_PATHS), so the
 *     directory is chrome repeated down a column. The full path is the hover, and it is what a click opens.
 *   • THE TAG NAMES THE DAMAGE, never a count of complaints. "1 to fix" was too vague to act on and loud
 *     enough to alarm; "using defaults" is what decides whether this is opened now or after lunch.
 *   • THE FILE NAME OPENS THE FILE, because every one of these ends there and the app is an editor with the
 *     file in it. `hit="pair"` is what lets that click coexist with a row-wide press that opens the row.
 *   • A STRAY KEY IS FIXED HERE, not by going to the file. It is the one problem on this card whose remedy is
 *     already fully known by the time the line is drawn — the daemon named the key and guessed the spelling —
 *     so the line that says "did you mean skills?" ends in the click that means it. Which lines earn a button
 *     and which do not is manifestNotice.ts's decision, with the reasoning; the card just draws them. */

const { reports, hasProblems, repair } = useManifestProblems();

const notices = computed(() => manifestNotices(reports.value));

// Which rows are open, keyed by path. Nothing is open on arrival: the card's job then is to say WHICH files and
// HOW BAD, and it does that in a line each.
const opened = ref<Record<string, boolean>>({});
const toggle = (path: string, open: boolean): void => {
    opened.value = { ...opened.value, [path]: open };
};

/* ONE BUSY FLAG AND ONE NOTICE FOR THE WHOLE CARD, rather than per button. These are sub-second writes of a
 * kilobyte file, and a reader who clicks one is not clicking another mid-flight; a `useAsyncAction` per row
 * would be state proportional to the list for a case that cannot happen. `useAsyncAction` also ignores re-entry
 * while busy, so the double-click that would otherwise send the same removal twice is already a no-op.
 *
 * THE FAILURES ARE WORTH PRINTING, which is why there is a Notice here at all. The likeliest of the daemon's
 * refusals are races with the reader's own editor — the key is already gone, or the name is already taken —
 * and they arrive as sentences saying so. Swallowing those would leave a button that visibly does nothing on
 * the one card whose subject is things quietly not working. */
const { busy, notice: repairNotice, run } = useAsyncAction();
// Which file the last press was against, so a refusal is drawn under THAT row rather than beneath the list. On
// a card that can hold three files, a failure at the bottom of all of them is a message the reader has to
// place before they can read it.
const acting = ref<string | undefined>(undefined);
const applyRepair = (path: string, action: ManifestRepairAction): Promise<void> => {
    acting.value = path;
    return run(
        () => repair({ path, key: action.key, ...(action.to === undefined ? {} : { to: action.to }) }),
        action.to === undefined ? `Couldn't remove "${action.key}".` : `Couldn't rename "${action.key}".`,
    );
};
</script>

<template>
    <RowGroup v-if="hasProblems" label="Some settings aren't being applied">
        <DisclosureRow
            v-for="notice in notices"
            :key="notice.path"
            icon="exclamation-triangle"
            tone="warning"
            hit="pair"
            :open="opened[notice.path] === true"
            @update:open="toggle(notice.path, $event)"
        >
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        class="cursor-pointer rounded-sm text-left font-mono text-xs hover:text-link hover:underline"
                        :title="notice.path"
                        @click="void openWorkspaceRef(notice.path)"
                    >
                        {{ notice.file }}
                    </button>
                    <!-- Beside the name, not at the row's far edge: it is a fact ABOUT this file, and parked
                         against the right rail of a wide card it is a 700px eye-jump from the thing it
                         qualifies. -->
                    <StatusBadge variant="neutral" size="xs" :label="notice.impact" />
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-1 pb-1 text-2xs">
                    <!-- The buttons sit ON the line they answer, not collected under the list. A row can carry
                         several stray keys, and a strip of "Remove it"s at the bottom would make the reader
                         match each to a line by position, which is exactly the work the button was added to
                         save. `items-baseline` keeps the small labels sitting on the sentence's own line. -->
                    <div v-for="(line, index) in notice.lines" :key="index" class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <p class="text-muted">{{ line.text }}</p>
                        <!-- A LINE'S ACTIONS WRAP AS A PAIR. Nested rather than laid out beside the sentence,
                             because in a narrow panel the flat version broke BETWEEN the two buttons: "Rename
                             it" finishing one line's sentence and "Remove it" starting the next, directly
                             above a different key's sentence, which is the one arrangement where a click can
                             land on the wrong key's repair. The inner wrap is kept so a pair too wide for the
                             panel still breaks rather than overflowing.

                             Short on screen, complete to a hover and to a screen reader: the visible label
                             leans on the sentence it follows, and `spoken` is that sentence's subject put
                             back for whoever reaches the button without it. -->
                        <span v-if="line.repairs.length > 0" class="flex flex-wrap items-center gap-2">
                            <Button
                                v-for="action in line.repairs"
                                :key="action.label"
                                size="small"
                                severity="secondary"
                                :label="action.label"
                                :aria-label="action.spoken"
                                :title="action.spoken"
                                :disabled="busy"
                                @click="void applyRepair(notice.path, action)"
                            />
                        </span>
                    </div>
                    <!-- The action outranks the diagnosis: the one line here anybody has to do anything with. -->
                    <p v-if="notice.fix !== undefined" class="text-content">{{ notice.fix }}</p>
                    <!-- Only the refusals reach here. A repair that WORKED says so by the row disappearing:
                         the write moves the file, the watcher invalidates `manifests`, and the daemon re-reads
                         it on the way to answering — so a success banner would be a second announcement of
                         something the reader is already watching happen. -->
                    <Notice v-if="repairNotice && acting === notice.path" :of="repairNotice" />
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
