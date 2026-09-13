<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import Icon from "@intentic/ui/icon";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { badgeChip, badgeClass, badgeText } from "./viewBadge";

/*
 * THE COUNT CHIP, drawn once for every surface that shows one: the rail's navigation tiles and its live-runtime
 * cluster, the phone's tab bar, the sandbox avatar, the hub's section rows. One component for the same reason
 * RunningMark is one — five copies of `min-w-4 rounded-full px-1 … font-semibold leading-4` had already drifted
 * into two type sizes and two ways of centring the glyph inside them, and drift in a four-pixel plate is
 * invisible until two of them are on screen at once.
 *
 * THE `v-if` HAD TO MOVE IN HERE, and that is the whole reason this exists as a component rather than a class.
 * Every call site used to test `badge && badgeChip(badge)` on the chip itself, so the moment a poll came back
 * empty the element was gone from the DOM in that same tick and there was nothing left to animate out. Vue's
 * <Transition> can only hold a leaving element it owns, so the test has to be inside it: callers now pass the
 * badge, including the undefined one, and this decides whether there is anything to draw.
 *
 * While the chip is leaving, Vue keeps the OUTGOING vnode untouched — so the tone and the number it fades out
 * with are the ones it had when it still meant something, not a re-render against the badge that has since
 * become undefined.
 *
 * POSITIONING AND TYPE SIZE ARE THE CALLER'S, like RunningMark's: only the caller knows which corner its tile
 * has free and how big the plate is in its own row. They land on the root through attribute inheritance, and
 * the root is the thing that moves, so an `absolute` chip slides against the corner it is pinned to.
 *
 * `inline-flex`, not `flex`: the hub row's chip sits inline in a `#meta` cluster, where a block box would take
 * the whole line. On the corner badges it makes no difference — they are absolutely positioned, so their
 * display is blockified anyway.
 */

const { badge } = defineProps<{ badge?: ViewBadge | undefined }>();

// The badge only while it has a chip to draw: `v-if` on the value, so the template narrows and the leave
// transition gets a falsy toggle rather than a changed prop.
const shown = computed<ViewBadge | undefined>(() => (badge !== undefined && badgeChip(badge) ? badge : undefined));
</script>

<template>
    <!--
        Motion, and the reduced-motion answer for it, live on `.ui-badge` in the design system's utilities.css.

        `appear`, so the chip animates whenever it lands rather than only when it toggles in a component that was
        already mounted. The corner badges barely need it — the rail and the tab bar outlive every route, and their
        counts arrive from a query a moment after first paint, which is a toggle. The hub's row chip is the case it
        is for: it lives in a `#meta` slot the row only renders when there is a fact to put in it, so the chip
        MOUNTS with something to say and would otherwise simply be there. Making the slot unconditional instead
        would put an empty cluster in every hub row and a `gap-4` minimum after every title that has no badge.
    -->
    <Transition name="ui-badge" appear>
        <span
            v-if="shown"
            class="ui-badge inline-flex min-w-4 items-center justify-center rounded-full px-1 text-center font-semibold leading-4"
            :class="badgeClass(shown)"
        >
            <!-- A mark REPLACES the number rather than sitting beside it: the chip is four pixels of glance, and
                 a glyph and a digit in it would be two claims competing for the same read. -->
            <Icon v-if="shown.mark !== undefined" :name="shown.mark as IconName" />
            <template v-else>{{ badgeText(shown) }}</template>
        </span>
    </Transition>
</template>
