<script setup lang="ts">
import { AnchoredOverlay, ui, useHoverIntent } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../client/sandbox/useRole";
import { foldStamps, type Stamp, STAMP_ICONS, stampMark, stampTone } from "../../models/fleet/board/stamps";
import { canStartFresh, draftFreshSession } from "../../models/fleet/freshSession";
import { useAgents } from "../../models/fleet/useAgents";
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";

// THE CARD'S STAMPS: one glyph per check that ran on its work, side by side in its corner (stamps.ts). The glyph says
// which check it was and its tone says how it came out. A number or `!` beside a glyph means that stamp needs you.
// A pointer that stays, or a press, opens a small card that says each stamp in words. From that card the reader can
// open the chat a check ran in, or run a check again when the work has moved past it. None of it is a gate: every check
// is optional, and CI checks everything once the work is pushed.

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
        // Whether the stamps are a press of their own. A rail row is a button already, so there the stamps open their
        // card on hover only, and a click selects the row.
        press?: boolean;
    }>(),
    { agent: undefined, quiet: false, max: 4, press: true },
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

// Where it ran: the card's own turn, a fresh session that saw only the work, or the agent's own chat, which had read
// how the work was made.
const whereOf = (stamp: Stamp): string => {
    if (stamp.kind === `self`) {
        return t(`agents.stamps.whereSelf`);
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

// Opens for a pointer that stays and waits for one that overshoots onto the card, as DevRebuild's card does. A press
// pins it open until a click outside closes it.
const anchor = ref<HTMLElement>();
const hover = useHoverIntent({ open: 200, close: 150, warm: 300 });
const pinned = ref(false);
const open = computed({
    get: () => pinned.value || hover.shown.value,
    set: (value: boolean) => {
        if (value) {
            hover.show();
            return;
        }
        pinned.value = false;
        hover.hide();
    },
});
const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        hover.enter();
    }
};
const onLeave = (): void => hover.leave();
const onCardEnter = (): void => hover.cancel();
const onPress = (event: MouseEvent): void => {
    // The card's own click opens the card; this one is the stamps'.
    event.stopPropagation();
    pinned.value = !open.value;
    if (!pinned.value) {
        hover.hide();
    }
};

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
    <component
        :is="press ? `button` : `span`"
        v-if="stamps.length > 0"
        ref="anchor"
        :type="press ? `button` : undefined"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-sm"
        :class="press ? `cursor-pointer` : undefined"
        data-stamps
        :role="press ? undefined : `img`"
        :aria-label="label"
        :aria-expanded="press ? open : undefined"
        @click="press ? onPress($event) : undefined"
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
            <Icon :name="STAMP_ICONS[stamp.kind]" :class="stamp.outcome === `running` ? `motion-safe:animate-pulse` : undefined" />
            <span v-if="stampMark(stamp)" class="text-[0.7em] font-semibold leading-none tabular-nums" data-stamp-mark>{{ stampMark(stamp) }}</span>
        </span>
        <span v-if="fold.folded > 0" class="text-[0.7em] font-medium leading-none text-subtle" aria-hidden="true">+{{ fold.folded }}</span>
        <AnchoredOverlay v-model="open" :anchor="anchor" side="top" cross="end" :restore-focus="pinned">
            <div class="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-0.5 p-1.5 text-left" data-stamps-card @pointerenter="onCardEnter" @pointerleave="onLeave">
                <p class="px-1.5 pb-0.5 pt-1 text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`agents.stamps.heading`) }}</p>
                <div v-for="stamp in stamps" :key="stamp.kind" class="flex items-start gap-1" data-stamp-row :data-stamp-kind="stamp.kind">
                    <component
                        :is="stamp.by === undefined ? `div` : `button`"
                        :type="stamp.by === undefined ? undefined : `button`"
                        class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1.5 text-left"
                        :class="stamp.by === undefined ? undefined : `cursor-pointer hover:bg-overlay`"
                        v-tooltip.top="stamp.by === undefined ? undefined : t(`agents.stamps.openTitle`)"
                        @click="openCheck(stamp)"
                    >
                        <Icon :name="STAMP_ICONS[stamp.kind]" class="mt-px shrink-0 text-sm" :class="stampTone(stamp, false)" />
                        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span class="text-xs leading-snug">
                                <span class="font-medium text-content">{{ kindName(stamp) }}</span>
                                <span class="text-muted"> · {{ stateOf(stamp) }}</span>
                            </span>
                            <span class="text-2xs leading-relaxed text-muted">
                                {{ whereOf(stamp) }}<span v-if="stamp.stale" class="text-warning"> · {{ t(`agents.stamps.stale`) }}</span>
                            </span>
                            <code
                                v-if="stamp.check"
                                class="mt-1 break-all rounded-md border border-line bg-canvas px-2 py-1 font-mono text-2xs leading-relaxed text-content"
                                >{{ stamp.check }}</code
                            >
                            <span v-if="unviewedOf(stamp)" class="mt-0.5 flex items-start gap-1.5 text-2xs leading-relaxed text-muted">
                                <Icon name="eye-slash" class="mt-0.5 shrink-0 text-warning" />{{ unviewedOf(stamp) }}
                            </span>
                        </span>
                        <Icon v-if="stamp.by !== undefined" name="chevron-right" class="mt-1 shrink-0 text-2xs text-subtle" />
                    </component>
                    <button
                        v-if="offersAgain(stamp)"
                        type="button"
                        :class="ui.textButton({ size: `xs` }, `mt-1.5 shrink-0 font-medium`)"
                        v-tooltip.top="{ title: t(`agents.stamps.againTitle`), note: t(`agents.stamps.againNote`) }"
                        data-stamp-again
                        @click="runAgain(stamp)"
                    >
                        {{ t(`agents.stamps.again`) }}
                    </button>
                </div>
            </div>
        </AnchoredOverlay>
    </component>
</template>
