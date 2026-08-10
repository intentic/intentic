<!-- THE APP'S COLOUR, PICKED — two rails, a set of starting points, and the hex for anyone who arrived with one.

     IT PICKS A HUE AND A SATURATION, NOT AN ARBITRARY COLOUR, and that is the whole design. The accent it
     produces always sits at one fixed lightness, because that lightness is what every contrast promise in the
     design system is made of (see themeColor.ts) — so a general-purpose colour square, whose vertical axis is
     exactly the thing that must not move, would spend two thirds of its area offering choices this app cannot
     honour, and quietly correct the user afterwards. Two rails offer only what is real, and what you drag is
     what you get.

     THE RAILS ARE PAINTED IN THE COLOURS THEY SELECT. Each hue stop is computed through the same gamut mapping
     the accent itself goes through, so the rail is a preview of the wheel AT THIS SATURATION rather than a
     stock spectrum: turn the saturation down and the rail visibly quietens with it. Its own paint keeps a
     floor, though — at zero saturation an honest rail would be twelve identical greys, and the one control
     that has to show what hue means would show nothing.

     THE HEX FIELD TAKES ANYTHING AND ANSWERS WITH WHAT IT BECAME. Paste a brand colour off a website and it
     keeps its hue and its saturation, gives up its lightness to the ladder, and the field rewrites itself to
     the colour that actually landed — so the value on screen is never a colour the app isn't wearing. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { type Accent, accentHex, DEFAULT_ACCENT, readAccent } from "../themeColor.js";

/** The accent, as `#rrggbb`. Always written back on the ladder's own lightness. */
const model = defineModel<string>({ required: true });

const accent = computed<Accent>(() => readAccent(model.value) ?? readAccent(DEFAULT_ACCENT)!);

const put = (next: Partial<Accent>): void => {
    model.value = accentHex({ ...accent.value, ...next });
};

/* Somewhere to start, for the reader who wants a colour rather than a hue. Nine points around the wheel plus a
 * near-grey, which is the one choice the rails make hardest to land on by hand and the one a lot of people
 * want: an app with a colour in it rather than an app made OF one. */
const PRESETS: readonly (Accent & { readonly label: string })[] = [
    { label: `Ember`, hue: 55, saturation: 1 },
    { label: `Crimson`, hue: 22, saturation: 0.86 },
    { label: `Rose`, hue: 355, saturation: 0.8 },
    { label: `Orchid`, hue: 320, saturation: 0.78 },
    { label: `Iris`, hue: 285, saturation: 0.85 },
    { label: `Cobalt`, hue: 255, saturation: 0.92 },
    { label: `Lagoon`, hue: 210, saturation: 0.95 },
    { label: `Fern`, hue: 150, saturation: 0.86 },
    { label: `Brass`, hue: 90, saturation: 0.95 },
    { label: `Graphite`, hue: 250, saturation: 0.14 },
];
const presets = PRESETS.map((preset) => ({ label: preset.label, hex: accentHex(preset) }));

// The rails' own paint. Below this the hue rail stops being able to say what it selects — see the header.
const RAIL_SATURATION_FLOOR = 0.55;
const hueRail = computed(() => {
    const saturation = Math.max(RAIL_SATURATION_FLOOR, accent.value.saturation);
    // Every 30°, which is close enough that the browser's sRGB interpolation between stops stays on the wheel.
    return `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => accentHex({ hue: i * 30, saturation })).join(`, `)})`;
});
const saturationRail = computed(() => {
    const { hue } = accent.value;
    return `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((saturation) => accentHex({ hue, saturation })).join(`, `)})`;
});

/* Pointer capture rather than window listeners, like <ResizeSeam>: the first frame of any drag leaves a rail
 * 10px tall, and the events have to keep arriving at the rail that started it. */
const dragging = ref<`hue` | `saturation` | undefined>(undefined);

const fractionAt = (event: PointerEvent): number => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return rect.width === 0 ? 0 : Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
};

const seek = (rail: `hue` | `saturation`, event: PointerEvent): void => {
    const fraction = fractionAt(event);
    put(rail === `hue` ? { hue: fraction * 360 } : { saturation: fraction });
};

const start = (rail: `hue` | `saturation`, event: PointerEvent): void => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging.value = rail;
    seek(rail, event);
};

const move = (rail: `hue` | `saturation`, event: PointerEvent): void => {
    if (dragging.value === rail) {
        seek(rail, event);
    }
};

const end = (): void => {
    dragging.value = undefined;
};

// Arrow keys move the rail a step, Home/End take it to either end — the slider role promises both.
const nudge = (rail: `hue` | `saturation`, event: KeyboardEvent): void => {
    const direction = event.key === `ArrowRight` || event.key === `ArrowUp` ? 1 : event.key === `ArrowLeft` || event.key === `ArrowDown` ? -1 : 0;
    if (direction === 0 && event.key !== `Home` && event.key !== `End`) {
        return;
    }
    event.preventDefault();
    const edge = event.key === `Home` ? 0 : event.key === `End` ? 1 : undefined;
    if (rail === `hue`) {
        put({ hue: edge === undefined ? (accent.value.hue + direction * 4 + 360) % 360 : edge * 359 });
    } else {
        put({ saturation: edge ?? Math.min(1, Math.max(0, accent.value.saturation + direction * 0.04)) });
    }
};

/* The field is only bound to the model while it is not being typed in: a partially typed hex is not a colour,
 * and rewriting it mid-keystroke is how a field fights the person filling it. It re-syncs on blur, which is
 * also where an unparseable value is quietly returned to the colour in force. */
const typed = ref(model.value);
const editing = ref(false);
watch(model, (value) => {
    if (!editing.value) {
        typed.value = value;
    }
});

const commit = (): void => {
    editing.value = false;
    const parsed = readAccent(typed.value.trim());
    if (parsed !== undefined) {
        model.value = accentHex(parsed);
    }
    typed.value = model.value;
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- What was picked, at the size a colour needs to be judged at, with its hex beside it. -->
        <div class="flex items-center gap-3">
            <span class="size-9 shrink-0 rounded-lg border border-line" :style="{ background: model }" />
            <input
                v-model="typed"
                type="text"
                spellcheck="false"
                aria-label="Accent colour hex"
                class="w-28 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-xs text-content uppercase focus:outline-none focus:ring-1 focus:ring-primary-500"
                @focus="editing = true"
                @blur="commit()"
                @keydown.enter="commit()"
            />
            <button
                v-if="model !== DEFAULT_ACCENT"
                type="button"
                class="ml-auto rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-content"
                @click="model = DEFAULT_ACCENT"
            >
                Reset
            </button>
        </div>

        <div class="flex flex-col gap-2.5">
            <div
                role="slider"
                tabindex="0"
                aria-label="Hue"
                :aria-valuenow="Math.round(accent.hue)"
                aria-valuemin="0"
                aria-valuemax="360"
                class="relative h-2.5 cursor-pointer rounded-full focus:outline-none focus:ring-2 focus:ring-primary-500/60"
                :style="{ background: hueRail }"
                @pointerdown="start(`hue`, $event)"
                @pointermove="move(`hue`, $event)"
                @pointerup="end()"
                @pointercancel="end()"
                @keydown="nudge(`hue`, $event)"
            >
                <span
                    class="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm ring-1 ring-black/25"
                    :style="{ left: `${(accent.hue / 360) * 100}%`, background: model }"
                />
            </div>
            <div
                role="slider"
                tabindex="0"
                aria-label="Saturation"
                :aria-valuenow="Math.round(accent.saturation * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
                class="relative h-2.5 cursor-pointer rounded-full focus:outline-none focus:ring-2 focus:ring-primary-500/60"
                :style="{ background: saturationRail }"
                @pointerdown="start(`saturation`, $event)"
                @pointermove="move(`saturation`, $event)"
                @pointerup="end()"
                @pointercancel="end()"
                @keydown="nudge(`saturation`, $event)"
            >
                <span
                    class="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm ring-1 ring-black/25"
                    :style="{ left: `${accent.saturation * 100}%`, background: model }"
                />
            </div>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
            <button
                v-for="preset in presets"
                :key="preset.label"
                type="button"
                :title="preset.label"
                :aria-label="preset.label"
                :aria-pressed="model === preset.hex"
                class="size-6 cursor-pointer rounded-full border transition-transform hover:scale-110"
                :class="model === preset.hex ? `border-content ring-2 ring-content/25` : `border-line`"
                :style="{ background: preset.hex }"
                @click="model = preset.hex"
            />
        </div>
    </div>
</template>
