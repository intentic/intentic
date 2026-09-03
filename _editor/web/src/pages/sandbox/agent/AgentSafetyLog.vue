<script setup lang="ts">
import type { SafetyLogEntry } from "@intentic-app/api-contract";
import { Notice, RowGroup, RowNote, SkeletonRows } from "@intentic/ui";
import { computed } from "vue";
import { useSafetyLog } from "../../../composables/sandbox/useSafetyPolicy";

/* WHAT THE POLICY ABOVE ACTUALLY DID, and the half of this page that makes the other half writable.
 *
 * The page this replaced was six switches and no evidence. You could see that "delete files recursively" was
 * set to ask, and you could not see that it had asked you eleven times that week, nine of them about a search
 * whose pattern happened to look like a deletion. That is precisely the information needed to write a better
 * rule, and it existed nowhere.
 *
 * Prose makes that worse before it makes it better — a policy can say anything, and an owner who cannot see
 * what their words did has no way to discover that "be strict about deletes" is being read more strictly than
 * they meant. So every verdict is here, INCLUDING the allowed ones, which are most of them and are the entries
 * that matter: a card you answered is something you already know about, and a command waved through on your
 * policy's say-so is not. "Why wasn't I asked about that" is the question this list exists to answer.
 */

const { entries, isLoading, error } = useSafetyLog();

// What the row says happened, in the reader's terms rather than the schema's. The answer supersedes the
// outcome when there was one: "you allowed it" is a truer account of a card you clicked than "it asked".
const OUTCOMES: Readonly<Record<string, { label: string; tone: string }>> = {
    allowed: { label: `Ran`, tone: `text-content/50` },
    asked: { label: `Asked you`, tone: `text-warning` },
    refused: { label: `Refused`, tone: `text-danger` },
};
const answerLabel = (entry: SafetyLogEntry): { label: string; tone: string } => {
    if (entry.answer === `allowed`) {
        return { label: `You allowed it`, tone: `text-content/50` };
    }
    if (entry.answer === `declined`) {
        return { label: `You declined it`, tone: `text-danger` };
    }
    return OUTCOMES[entry.outcome] ?? { label: entry.outcome, tone: `text-content/50` };
};

const when = (at: number): string => new Date(at).toLocaleString(undefined, { month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit` });

const rows = computed(() => entries.value.slice(0, 50));
</script>

<template>
    <RowGroup label="Recent decisions">
        <SkeletonRows v-if="isLoading" :rows="4" description />

        <RowNote v-else-if="error !== undefined" variant="block">
            <Notice tone="danger">{{ error }}</Notice>
        </RowNote>

        <!-- An empty list is a real and common state (nothing the assistant ran matched anything worth judging),
             and it needs saying, or the group reads as broken. -->
        <RowNote v-else-if="rows.length === 0" variant="empty">
            Nothing has needed judging yet. Ordinary work — building, testing, editing, committing — never reaches the policy at all.
        </RowNote>

        <ul v-else class="divide-y divide-line-subtle">
            <li v-for="entry in rows" :key="`${entry.at}-${entry.program}`" class="px-3 py-2">
                <div class="flex items-baseline justify-between gap-3">
                    <span class="text-2xs font-medium" :class="answerLabel(entry).tone">{{ answerLabel(entry).label }}</span>
                    <span class="shrink-0 text-2xs text-content/40">
                        <template v-if="entry.machine">on {{ entry.machine }} · </template>{{ when(entry.at) }}
                    </span>
                </div>
                <!-- The sentence above the command, in that order: it is the judge's reason, and it is what
                     tells you whether the verdict was right. The command underneath is the evidence for it. -->
                <p class="mt-0.5 text-xs leading-relaxed text-content/85">{{ entry.sentence }}</p>
                <pre class="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-2xs text-content/55">{{ entry.program }}</pre>
            </li>
        </ul>
    </RowGroup>
</template>
