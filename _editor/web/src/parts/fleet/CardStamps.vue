<script setup lang="ts">
import { AnchoredOverlay, SectionHeader, ui, useHoverIntent } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../client/sandbox/useRole";
import { foldStamps, type Stamp, stampMark, stampTone } from "../../models/fleet/board/stamps";
import { canStartFresh, draftFreshSession } from "../../models/fleet/freshSession";
import { useAgents } from "../../models/fleet/useAgents";
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";
import RuleCommand from "../../components/RuleCommand.vue";
import StampBadge from "./StampBadge.vue";

// THE CARD'S STAMPS: one badge per check that ran on its work, side by side in its corner (stamps.ts, StampBadge). The
// symbol cut out of a badge says which check it was and the badge's ink says how it came out. A number or `!` beside a
// badge means that stamp needs you.
// A mark, never a press: a click on it is the card's, which opens the card. A pointer that stays opens a small card that
// says each stamp in words, from which the reader can open the chat a check ran in, or run a check again when the work
// has moved past it. None of it is a gate: every check is optional, and CI checks everything once the work is pushed.

const t = useT();

const props = withDefaults(
    defineProps<{
        stamps: readonly Stamp[];
        // The card whose work they vouch for, which Again starts a fresh session on. Absent where no roster card
        // stands behind the row.
        agent?: FleetAgent;
        // A receipt: passes are history there, so they take the corner's quiet ink.
        quiet?: boolean;
        // How many stamps the corner draws before the rest fold into "+N".
        max?: number;
    }>(),
    { agent: undefined, quiet: false, max: 4 },
);

const fold = computed(() => foldStamps(props.stamps, props.max));

const kindName = (stamp: Stamp): string =>
    stamp.kind === `self` ? t(`agents.stamps.self`) : t(`agents.freshSession.kind.${stamp.kind}`);

// How it came out, in the words after the kind's name.
const stateOf = (stamp: Stamp): string => {
    if (stamp.kind === `self`) {
        return t(`agents.stamps.selfState.${stamp.outcome === `passed` ? `passed` : `failed`}`);
    }
    if (stamp.outcome === `findings`) {
        const count = stamp.findings ?? 0;
        const open = stamp.open ?? count;
        return open < count ? t(`agents.stamps.state.someOpen`, { open, count }) : t(`agents.stamps.state.findings`, { count }, count);
    }
    if (stamp.outcome === `passed` && (stamp.findings ?? 0) > 0) {
        return t(`agents.stamps.state.handled`, { count: stamp.findings ?? 0 }, stamp.findings ?? 0);
    }
    return t(`agents.stamps.state.${stamp.outcome}`);
};

// Where it ran: a fresh session that saw only the work, or the agent's own chat, which had read how the work was made.
// The agent's own check says nothing here: its name already says who ran it.
const whereOf = (stamp: Stamp): string | undefined => {
    if (stamp.kind === `self`) {
        return undefined;
    }
    return stamp.own === true ? t(`agents.stamps.whereOwn`) : t(`agents.stamps.whereFresh`);
};

const unviewedOf = (stamp: Stamp): string | undefined =>
    stamp.unviewed === undefined ? undefined : t(`agents.stamps.unviewed`, { count: stamp.unviewed }, stamp.unviewed);

// The accessible name: every stamp, one a line, as the card says them.
const label = computed(() =>
    [t(`agents.stamps.heading`), ...props.stamps.map((stamp) => `${kindName(stamp)}: ${stateOf(stamp)}${stamp.stale ? ` · ${t(`agents.stamps.stale`)}` : ``}`)].join(
        `\n`,
    ),
);

const { agentById, open: openAgent } = useAgents();
const { canReview } = useRole();
// A fresh session can be cut from this work now, by a reader who may start one. Offered on a check the work has moved
// past or one that didn't finish; the agent's own check is its next turn's to run.
const again = computed(() => props.agent !== undefined && canReview.value && canStartFresh(props.agent));
const offersAgain = (stamp: Stamp): boolean => again.value && stamp.kind !== `self` && (stamp.stale || stamp.outcome === `failed`);

// Opens for a pointer that stays and waits for one that overshoots onto the card, as DevRebuild's card does.
const anchor = ref<HTMLElement>();
const hover = useHoverIntent({ open: 200, close: 150, warm: 300 });
const open = computed({
    get: () => hover.shown.value,
    set: (value: boolean) => (value ? hover.show() : hover.hide()),
});
const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        hover.enter();
    }
};
const onLeave = (): void => hover.leave();
const onCardEnter = (): void => hover.cancel();

const openCheck = (stamp: Stamp): void => {
    const card = stamp.by === undefined ? undefined : agentById(stamp.by);
    if (card !== undefined) {
        open.value = false;
        openAgent(card, `peek`);
    }
};
const runAgain = (stamp: Stamp): void => {
    if (props.agent !== undefined && stamp.kind !== `self`) {
        open.value = false;
        void draftFreshSession(props.agent, stamp.kind);
    }
};
</script>

<template>
    <span
        v-if="stamps.length > 0"
        ref="anchor"
        class="inline-flex shrink-0 cursor-default items-center gap-1"
        data-stamps
        role="img"
        :aria-label="label"
        @pointerenter="onEnter"
        @pointerleave="onLeave"
    >
        <span
            v-for="stamp in fold.shown"
            :key="stamp.kind"
            class="inline-flex items-center gap-px"
            :class="stampTone(stamp, quiet)"
            data-stamp
            :data-stamp-kind="stamp.kind"
            :data-stamp-outcome="stamp.outcome"
            :data-stamp-stale="stamp.stale ? `` : undefined"
            aria-hidden="true"
        >
            <StampBadge :kind="stamp.kind" :class="stamp.outcome === `running` ? `motion-safe:animate-pulse` : undefined" />
            <span v-if="stampMark(stamp)" class="text-[0.7em] font-semibold leading-none tabular-nums" data-stamp-mark>{{ stampMark(stamp) }}</span>
        </span>
        <span v-if="fold.folded > 0" class="text-[0.7em] font-medium leading-none text-subtle" aria-hidden="true">+{{ fold.folded }}</span>
        <AnchoredOverlay v-model="open" :anchor="anchor" side="top" cross="end" :restore-focus="false">
            <div class="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-1 text-left" data-stamps-card @pointerenter="onCardEnter" @pointerleave="onLeave">
                <SectionHeader :label="t(`agents.stamps.heading`)" density="dense" class="px-1.5 py-0.5" />
                <div v-for="stamp in stamps" :key="stamp.kind" class="flex items-start gap-1" data-stamp-row :data-stamp-kind="stamp.kind">
                    <component
                        :is="stamp.by === undefined ? `div` : `button`"
                        :type="stamp.by === undefined ? undefined : `button`"
                        class="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left"
                        :class="stamp.by === undefined ? undefined : `cursor-pointer hover:bg-overlay`"
                        v-tooltip.top="stamp.by === undefined ? undefined : t(`agents.stamps.openTitle`)"
                        @click="openCheck(stamp)"
                    >
                        <StampBadge :kind="stamp.kind" class="mt-px shrink-0 text-sm" :class="stampTone(stamp, false)" />
                        <span class="flex min-w-0 flex-1 flex-col gap-1">
                            <span class="text-xs leading-snug">
                                <span class="font-medium text-content">{{ kindName(stamp) }}</span>
                                <span class="text-muted"> · {{ stateOf(stamp) }}</span>
                                <span v-if="whereOf(stamp)" class="text-subtle"> · {{ whereOf(stamp) }}</span>
                                <span v-if="stamp.stale" class="text-warning"> · {{ t(`agents.stamps.stale`) }}</span>
                            </span>
                            <!-- Clamped to three lines: the card says what ran, the agent's chat holds the rest. -->
                            <span
                                v-if="stamp.check"
                                class="block max-h-[calc(3lh+0.5rem)] overflow-hidden rounded border border-line bg-canvas px-1.5 py-1 text-2xs leading-relaxed"
                                :title="stamp.check"
                                ><RuleCommand :command="stamp.check" wrap class="break-all"
                            /></span>
                            <span v-if="unviewedOf(stamp)" class="flex items-center gap-1 text-2xs leading-snug text-muted">
                                <Icon name="eye-slash" class="shrink-0 text-warning" />{{ unviewedOf(stamp) }}
                            </span>
                        </span>
                        <Icon v-if="stamp.by !== undefined" name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                    </component>
                    <button
                        v-if="offersAgain(stamp)"
                        type="button"
                        :class="ui.textButton({ size: `xs` }, `mt-1 shrink-0 font-medium`)"
                        v-tooltip.top="{ title: t(`agents.stamps.againTitle`), note: t(`agents.stamps.againNote`) }"
                        data-stamp-again
                        @click="runAgain(stamp)"
                    >
                        {{ t(`agents.stamps.again`) }}
                    </button>
                </div>
            </div>
        </AnchoredOverlay>
    </span>
</template>
