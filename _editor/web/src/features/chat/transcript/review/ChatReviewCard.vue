<script setup lang="ts">
import type { ReviewFinding, ReviewFindings } from "@intentic/sandbox-contract/events/review";
import { Button, Icon, StatusBadge, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { toWorkspacePath } from "../../../../lib/files/fileRefs";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { findingChips, findingPlace, findingsLabel, fixRequest, openFindings, originFixRequest, reviewerLabel, summaryParts } from "./reviewCard";

// A code review's findings, inline where the agent reported them (events/review.ts): one row per finding, most severe
// first, its place a press away and its scenario or the reviewer's explanation a press below. The same card whichever
// harness reviewed. Fix puts the ask in the composer, never sends it: the reader presses Send. In a fresh session on
// another conversation's work, Fix puts it in THAT conversation's composer instead (surface.fixIn): the agent that made
// the work knows which findings hold, and this one only saw the result. A review re-reported with
// its fixes applied is drawn again further down, so this one folds to a line. Everything that leaves the card goes
// through the chat's surface, so a published conversation draws the same findings with nothing to press.

const t = useT();

const props = defineProps<{ review: ReviewFindings }>();

const surface = useChatSurface();
const earlierOpen = ref(false);
const folded = computed(() => props.review.superseded === true && !earlierOpen.value);
const open = computed(() => openFindings(props.review));

// Which rows show their detail, by index: a review is short, and a reader opens the ones they mean to act on.
const expanded = ref<ReadonlySet<number>>(new Set());
const toggle = (index: number): void => {
    const next = new Set(expanded.value);
    if (!next.delete(index)) {
        next.add(index);
    }
    expanded.value = next;
};
const detailOf = (finding: ReviewFinding): string | undefined => finding.scenario ?? finding.body;

// An absolute path (Codex names them so) is the checkout's own file; the surface resolves it in this conversation's copy.
const openAt = (finding: ReviewFinding): void => {
    surface.openFile?.(toWorkspacePath(finding.file) ?? finding.file, finding.line);
};

// Where Fix goes: the origin of a fresh session while it is on the fleet, else this chat's own composer.
const origin = computed(() => surface.fixIn?.());
const canFix = computed(() => origin.value !== undefined || surface.draftMessage !== undefined);
const fixTip = computed(() =>
    origin.value === undefined ? undefined : { title: origin.value.title, note: t(`agents.freshSession.fixInOriginTip`, { title: origin.value.title }) },
);

const draftFix = (findings: readonly ReviewFinding[]): void => {
    const target = origin.value;
    if (target !== undefined) {
        target.draft(originFixRequest(findings));
        return;
    }
    surface.draftMessage?.(fixRequest(findings));
};
</script>

<template>
    <!-- Inset like the answer's own prose, so the card's left edge lines up with the words around it. -->
    <section class="flex w-full flex-col px-3.5" :aria-label="t(`chat.chatReview.title`)" data-chat-review>
        <div v-if="folded" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
            <Icon name="history" class="shrink-0 text-2xs" />
            <span class="min-w-0 truncate">{{ t(`chat.chatReview.superseded`) }}</span>
            <button type="button" :class="ui.textButton({ size: `xs`, flush: true }, `shrink-0 font-medium`)" @click="earlierOpen = true">
                {{ t(`chat.chatReview.show`) }}
            </button>
        </div>
        <div v-else class="flex flex-col overflow-hidden rounded-lg border border-line">
            <!-- The head: what this is, who reviewed at what effort, how much it found, and the one press for all of it. -->
            <div class="flex min-w-0 items-center gap-2 px-3 py-1.5 text-2xs">
                <Icon name="list-check" class="shrink-0 text-xs text-muted" />
                <span class="shrink-0 font-medium text-content">{{ t(`chat.chatReview.title`) }}</span>
                <span class="min-w-0 truncate text-subtle"
                    >{{ reviewerLabel(review) }}<template v-if="review.level"> · {{ review.level }}</template></span
                >
                <span class="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-subtle">
                    <Icon v-if="review.findings.length === 0" name="check-circle" class="text-2xs text-success" />
                    {{ findingsLabel(review) }}
                </span>
                <Button v-if="open.length > 1 && canFix" size="small" tier="boring" class="shrink-0" v-tooltip.top="fixTip" @click="draftFix(open)">{{
                    origin ? t(`agents.freshSession.fixAllInOrigin`) : t(`chat.chatReview.fixAll`)
                }}</Button>
            </div>
            <ol v-if="review.findings.length > 0" class="flex flex-col divide-y divide-line border-t border-line">
                <li v-for="(finding, index) in review.findings" :key="index" class="flex min-w-0 flex-col gap-0.5 px-3 py-1.5 text-2xs">
                    <!-- The sentence takes the row's whole width: the chips sit on the line under it, so a narrow column (a phone,
                         the docked chat) never squeezes the words into a sliver beside them. -->
                    <button
                        type="button"
                        class="flex min-w-0 cursor-pointer items-start gap-1.5 text-left disabled:cursor-default"
                        :disabled="detailOf(finding) === undefined"
                        :aria-expanded="detailOf(finding) === undefined ? undefined : expanded.has(index)"
                        @click="toggle(index)"
                    >
                        <Icon
                            :name="expanded.has(index) ? `chevron-down` : `chevron-right`"
                            class="shrink-0 text-3xs text-subtle"
                            :class="{ invisible: detailOf(finding) === undefined }"
                        />
                        <span class="min-w-0" :class="finding.outcome === undefined ? `text-content` : `text-subtle`">
                            <template v-for="(part, at) in summaryParts(finding.summary)" :key="at">
                                <code v-if="part.code" class="rounded-xs bg-content/7 px-1 font-mono">{{ part.text }}</code>
                                <template v-else>{{ part.text }}</template>
                            </template>
                        </span>
                    </button>
                    <!-- On the hang, under the words: the place (opening in this conversation's own checkout), the chips, Fix. -->
                    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-4.5">
                        <button
                            v-if="surface.openFile"
                            type="button"
                            :class="ui.textButton({ size: `xs`, tone: `subtle`, flush: true }, `min-w-0 font-mono`)"
                            v-tooltip.top="{ title: t(`chat.chatReview.openFile`), note: findingPlace(finding).full }"
                            @click="openAt(finding)"
                        >
                            <span class="truncate">{{ findingPlace(finding).short }}</span>
                        </button>
                        <span v-else class="min-w-0 truncate font-mono text-subtle">{{ findingPlace(finding).full }}</span>
                        <span v-if="findingChips(finding).length > 0" class="flex shrink-0 items-center gap-1">
                            <StatusBadge v-for="chip in findingChips(finding)" :key="chip.label" size="xs" :variant="chip.tone" :label="chip.label" />
                        </span>
                        <button
                            v-if="finding.outcome === undefined && canFix"
                            type="button"
                            :class="ui.textButton({ size: `xs`, flush: true }, `shrink-0`)"
                            v-tooltip.top="fixTip"
                            @click="draftFix([finding])"
                        >
                            {{ origin ? t(`agents.freshSession.fixInOrigin`) : t(`chat.chatReview.fixOne`) }}
                        </button>
                    </div>
                    <p v-if="expanded.has(index) && detailOf(finding)" class="pl-4.5 whitespace-pre-wrap text-muted">
                        <template v-for="(part, at) in summaryParts(detailOf(finding)!)" :key="at">
                            <code v-if="part.code" class="rounded-xs bg-content/7 px-1 font-mono">{{ part.text }}</code>
                            <template v-else>{{ part.text }}</template>
                        </template>
                    </p>
                </li>
            </ol>
        </div>
    </section>
</template>
