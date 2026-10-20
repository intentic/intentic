<!-- The desktop sign-in's rail of stations (DesktopAuth.vue): /login's three stops, lit as that page passes them. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

const props = defineProps<{
    // Which wait the sign-in is in.
    readonly stage: `checking` | `signin` | `handing` | `done`;
    // A beat the reader has to answer before it can move: a failure, or the two accounts disagreeing.
    readonly stalled: boolean;
}>();

const t = useT();

// The three waits, in the order they happen; the rail below draws one station per beat.
// Each name is asked for at render, so it follows the reader's language.
const BEATS = [
    { of: `checking`, name: () => t(`auth.desktopAuth.beatCheckBrowser`) },
    { of: `signin`, name: () => t(`auth.desktopAuth.beatConfirmGoogle`) },
    { of: `handing`, name: () => t(`auth.desktopAuth.beatHandOver`) },
] as const;

// How many beats are behind us, which is both the lit station count and the rail's fill. A beat the flow SKIPPED
// counts as reached: the platform already holding the credential satisfies Google's beat without asking.
const reached = computed(() => (props.stage === `done` ? BEATS.length : BEATS.findIndex((beat) => beat.of === props.stage)));
</script>

<template>
    <section class="rail">
        <ol class="steps" :style="{ '--reached': reached }">
            <li
                v-for="(beat, index) in BEATS"
                :key="beat.of"
                class="station"
                :class="{
                    'station-done': index < reached,
                    'station-now': index === reached && !stalled,
                    'station-stalled': index === reached && stalled,
                }"
                :aria-current="index === reached ? `step` : undefined"
            >
                <span class="entry-lozenge"></span>
                <h2>{{ beat.name() }}</h2>
            </li>
        </ol>
    </section>
</template>

<style scoped>
/* THE RAIL — /login's three stations, reporting instead of promising. */
.rail {
    --rail-gap: 1.75rem;

    width: 100%;
    margin-top: clamp(1.5rem, 4vh, 2.25rem);
}
.steps {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--rail-gap);
    padding-top: 1.25rem;
    border-top: 1px solid var(--rule-strong);
    text-align: left;
}
/* The rail IS the progress bar: the fill stops on the mark of the station being worked, one column pitch per beat
   (a column plus its gap is (100% + gap) / 3), and covers the whole rule once the handoff has landed. */
.steps::before {
    content: "";
    position: absolute;
    top: -1px;
    left: 0;
    height: 1px;
    width: min(100%, calc(var(--reached) * (100% + var(--rail-gap)) / 3));
    background: var(--ember);
    box-shadow: 0 0 8px color-mix(in oklab, var(--ember) 55%, transparent);
    transition: width 0.5s ease;
}
.station {
    position: relative;
}
/* The mark sits on the rail, not under it, so the row reads as one line with three stops rather than separate cards. */
.station .entry-lozenge {
    position: absolute;
    top: calc(-1.25rem - 0.325rem);
    left: 0;
    width: 0.65rem;
    height: 0.65rem;
    color: var(--ink-subtle);
    transition: color 0.3s ease;
}
.station h2 {
    font-family: var(--face-mark);
    font-size: 0.9375rem;
    font-weight: var(--font-weight-semibold);
    color: var(--ink-subtle);
    transition: color 0.3s ease;
}
.station-done .entry-lozenge {
    color: var(--gold);
}
.station-done h2 {
    color: var(--ink-muted);
}
.station-now .entry-lozenge {
    color: var(--ember);
    filter: var(--house-ember-mark-glow);
}
.station-now h2 {
    color: var(--gold-bright);
}
.station-stalled .entry-lozenge {
    color: var(--color-danger);
}
.station-stalled h2 {
    color: var(--ink);
}

@media (max-width: 40rem) {
    /* One column has no rail to hang marks off, so each station carries its own segment of it and lights that. */
    .steps {
        grid-template-columns: minmax(0, 1fr);
        gap: 0;
        padding-top: 0;
        border-top: 0;
    }
    .steps::before {
        display: none;
    }
    .station {
        padding: 0.5rem 0 0.5rem 1.5rem;
        border-left: 1px solid var(--rule-strong);
        transition: border-color 0.3s ease;
    }
    .station-done,
    .station-now {
        border-left-color: var(--ember);
    }
    /* Astride its own segment, as the marks sit on the rule when the three stand side by side; `top` is the label's
       optical centre, which is below the line box's own middle by the cap-height's share of the leading. */
    .station .entry-lozenge {
        top: 0.875rem;
        left: -0.325rem;
    }
}

/* The fill still lands where it should; it just arrives there without the travel. */
:root[data-motion="reduced"] .steps::before {
    transition: none;
}
</style>
