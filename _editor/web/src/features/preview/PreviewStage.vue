<!-- Where the framed app sits: full bleed, or at a phone's own CSS viewport inside a drawn handset. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ui } from "@intentic/ui";
import { phoneOuterSize, phoneScale, type PhoneModel } from "./phoneModels";

// One DOM shape serves both modes because the slot holds a LIVE iframe: moving it between two v-if branches would
// reload the app under preview on every switch, losing whatever state the reviewer had built up in it.
const { phone } = defineProps<{ phone?: PhoneModel | undefined }>();

// The handset is scaled to whatever the pane can hold, so the pane's size is a measurement, not a media query: this
// panel is a resizable pane and a floating window, never the viewport.
const pane = ref<HTMLElement | undefined>(undefined);
const paneSize = ref({ width: 0, height: 0 });
let observer: ResizeObserver | undefined;

// A classic scrollbar belongs to the framed document, which is cross-origin: no CSS here can reach it. The frame is
// widened by exactly its width instead and that strip clipped away, which lays the page out at the device's real width
// at two costs: a media query inside sees that width plus the gutter, and a page too short to scroll loses the strip's
// pixels rather than a scrollbar. Both are zero wherever scrollbars overlay (macOS, touch).
const gutter = ref(0);
const measureGutter = (): number => {
    const probe = document.createElement(`div`);
    probe.style.cssText = `position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll`;
    document.body.append(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return width;
};

onMounted(() => {
    gutter.value = measureGutter();
    const element = pane.value;
    if (element === undefined || typeof ResizeObserver === `undefined`) {
        return;
    }
    observer = new ResizeObserver(([entry]) => {
        const box = entry?.contentRect;
        if (box !== undefined) {
            paneSize.value = { width: box.width, height: box.height };
        }
    });
    observer.observe(element);
});
onUnmounted(() => observer?.disconnect());

const outer = computed(() => (phone === undefined ? { width: 0, height: 0 } : phoneOuterSize(phone)));

// What the plinth under the handset takes out of the pane's height: its two courses, their gaps and one line of
// inscription. Reserved before the fit, or the device is scaled to a height the group it stands in cannot hold.
const PLINTH = 40;
const scale = computed(() =>
    phone === undefined ? 1 : phoneScale(phone, { width: paneSize.value.width, height: Math.max(1, paneSize.value.height - PLINTH) }),
);
const chin = computed(() => phone?.chin ?? phone?.bezel ?? 0);

// The slot's own box. Full bleed fills the pane; a phone gets its exact CSS viewport, plus the clipped gutter.
const frame = computed(() =>
    phone === undefined ? { width: `100%`, height: `100%` } : { width: `${phone.width + gutter.value}px`, height: `${phone.height}px` },
);

// Laid-out size of the scaled handset, so the flex row centres the picture rather than the unscaled box behind it.
const sizerStyle = computed(() =>
    phone === undefined ? undefined : { width: `${outer.value.width * scale.value}px`, height: `${outer.value.height * scale.value}px` },
);
const deviceStyle = computed(() =>
    phone === undefined
        ? undefined
        : {
              width: `${outer.value.width}px`,
              height: `${outer.value.height}px`,
              padding: `${chin.value}px ${phone.bezel}px`,
              borderRadius: `${phone.radius + Math.min(phone.bezel, chin.value)}px`,
              transform: `scale(${scale.value})`,
              transformOrigin: `top left`,
          },
);
const screenStyle = computed(() =>
    phone === undefined ? undefined : { width: `${phone.width}px`, height: `${phone.height}px`, borderRadius: `${phone.radius}px` },
);

// The plinth's inscription: which handset this is, the viewport a media query inside it sees, and — only when the pane
// is too small to hold the device at 1:1 — how far down it has been scaled, which nothing else on screen says.
const caption = computed(() => {
    if (phone === undefined) {
        return ``;
    }
    const zoom = scale.value < 0.995 ? ` · ${Math.round(scale.value * 100)}%` : ``;
    return `${phone.label} · ${phone.width} × ${phone.height}${zoom}`;
});

// ONE STONE FOR THE FRAME AND EVERYTHING CUT OUT OF IT: the panel's own material with the page's ink mixed into it, so
// the plate stands a clear step off the wall in daylight and a clear step off the dark at night without naming a colour
// of its own. A literal here would be a cold slab on a warm wall in one look and invisible in another.
const STONE = { backgroundColor: `color-mix(in oklab, var(--color-content) 26%, var(--color-overlay))` };

// The base the handset stands on: two courses of the same stone, each one proud of the course above it, which is the
// shape under every tower on the site's temple. Widths ride the laid-out device; heights do not, so the steps stay one
// crisp pixel at any scale rather than dissolving with the phone.
const plinth = computed(() => {
    const width = outer.value.width * scale.value;
    return [
        { width: `${Math.round(width * 0.96)}px`, height: `3px`, opacity: `0.85` },
        { width: `${Math.round(width * 1.06)}px`, height: `4px`, opacity: `0.6` },
    ];
});

// The drawn frame's own furniture, measured off the hardware: camera cutout, earpiece, home indicator, home button.
// These are the DEVICE's CSS pixels, riding `deviceStyle`'s scale, so they are styles rather than utilities — the app's
// 4px spacing scale names nothing here, and rounding one to a step would draw a different phone.
const ISLAND = { top: `10px`, height: `28px`, width: `108px` };
const NOTCH = { height: `28px`, width: `156px` };
const PUNCH = { top: `10px`, height: `10px`, width: `10px` };
const HOME_INDICATOR = { bottom: `8px`, height: `4px` };
const EARPIECE = { top: `25px`, height: `5px`, width: `46px` };
const HOME_BUTTON = { bottom: `11px`, height: `34px`, width: `34px` };
const ROSETTE = { height: `11px`, width: `11px` };
</script>

<template>
    <div ref="pane" class="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden" :class="phone ? `p-4` : ``">
        <div :class="phone ? `flex shrink-0 flex-col items-center` : `flex h-full w-full`">
            <div :style="sizerStyle" :class="phone ? `shrink-0` : `h-full w-full`">
                <!-- The handset body: one plate of the panel's own material, ruled with a single hairline and standing
                     on its shadow — a frame the app is set into, never a photograph of a phone. It wears `bg-overlay`
                     under the inline fill on purpose: that class is the hook a skin paints its material through, and
                     the fill only re-lights it. -->
                <div
                    :style="[deviceStyle, phone ? STONE : {}]"
                    class="relative"
                    :class="phone ? `bg-overlay shadow-lg ring-1 ring-line-strong` : `h-full w-full`"
                >
                    <!-- The aperture's own rule, which is what makes the bezel read as cut rather than as a margin. -->
                    <div :style="screenStyle" class="relative overflow-hidden bg-white" :class="phone ? `ring-1 ring-line-strong` : `h-full w-full`">
                        <slot :frame="frame" />

                        <template v-if="phone">
                            <!-- The camera, as the model wears it, drawn in the frame's own stone: the cutout is where
                                 the plate comes down over the page, and a black blob would be the loudest thing on a
                                 calm stage while saying no more about what the page loses under it. -->
                            <span
                                v-if="phone.cutout === `island`"
                                class="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-overlay ring-1 ring-line-strong"
                                :style="[ISLAND, STONE]"
                                aria-hidden="true"
                            ></span>
                            <span
                                v-else-if="phone.cutout === `notch`"
                                class="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-b-2xl bg-overlay ring-1 ring-line-strong"
                                :style="[NOTCH, STONE]"
                                aria-hidden="true"
                            ></span>
                            <span
                                v-else-if="phone.cutout === `punch`"
                                class="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-overlay ring-1 ring-line-strong"
                                :style="[PUNCH, STONE]"
                                aria-hidden="true"
                            ></span>

                            <!-- Difference blending is what makes one bar legible on a white page and on a black one, as the real indicator is. -->
                            <span
                                v-if="phone.cutout !== `none`"
                                class="pointer-events-none absolute left-1/2 w-[32%] -translate-x-1/2 rounded-full bg-white/45 mix-blend-difference"
                                :style="HOME_INDICATOR"
                                aria-hidden="true"
                            ></span>
                        </template>
                    </div>

                    <!-- A home-button phone spends its forehead and chin on hardware, so the empty bezel would look like
                         a bug. The button is a ring around the house's lozenge: the one ornament this frame carries, and
                         the only model with the room to wear it. -->
                    <template v-if="phone?.cutout === `none`">
                        <span
                            class="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-content/25"
                            :style="EARPIECE"
                            aria-hidden="true"
                        ></span>
                        <span
                            class="pointer-events-none absolute left-1/2 grid -translate-x-1/2 place-items-center rounded-full ring-1 ring-content/20"
                            :style="HOME_BUTTON"
                            aria-hidden="true"
                        >
                            <span class="rotate-45 rounded-2xs ring-1 ring-content/20" :style="ROSETTE"></span>
                        </span>
                    </template>
                </div>
            </div>

            <!-- The plinth and its inscription. The group's height is reserved out of the fit above (PLINTH), so naming
                 the device never costs it room to stand. -->
            <template v-if="phone">
                <!-- Square, where every other edge here is eased: a course of a plinth is cut stone, and the site keeps
                     its carved edges square for the same reason. -->
                <span
                    v-for="(step, index) in plinth"
                    :key="index"
                    :class="index === 0 ? `mt-2` : ``"
                    :style="[step, STONE]"
                    aria-hidden="true"
                ></span>
                <p :class="ui.sectionLabel(`mt-2 truncate px-3 text-center text-2xs`)">{{ caption }}</p>
            </template>
        </div>
    </div>
</template>
