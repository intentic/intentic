<!-- Where the framed app sits: full bleed, or at a phone's own CSS viewport inside a drawn handset. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
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
const scale = computed(() => (phone === undefined ? 1 : phoneScale(phone, paneSize.value)));
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
</script>

<template>
    <div ref="pane" class="flex min-h-0 flex-1 items-center justify-center overflow-hidden" :class="phone ? `p-3` : ``">
        <div :style="sizerStyle" :class="phone ? `shrink-0` : `h-full w-full`">
            <!-- The handset body: a metal rail lit down both long edges, which is what reads as "phone" at a glance. -->
            <div
                :style="deviceStyle"
                class="relative"
                :class="
                    phone
                        ? `bg-[linear-gradient(105deg,#5c5c66_0%,#1d1d22_14%,#141418_50%,#1d1d22_86%,#5c5c66_100%)] shadow-2xl shadow-black/60`
                        : `h-full w-full`
                "
            >
                <template v-if="phone">
                    <!-- Side hardware, drawn just proud of the rail; percentages keep it in place at every model's height. -->
                    <span class="absolute -left-[2px] top-[16%] h-[4%] w-[3px] rounded-l-sm bg-[#4c4c58]" aria-hidden="true"></span>
                    <span class="absolute -left-[2px] top-[24%] h-[8%] w-[3px] rounded-l-sm bg-[#4c4c58]" aria-hidden="true"></span>
                    <span class="absolute -left-[2px] top-[34%] h-[8%] w-[3px] rounded-l-sm bg-[#4c4c58]" aria-hidden="true"></span>
                    <span class="absolute -right-[2px] top-[27%] h-[12%] w-[3px] rounded-r-sm bg-[#4c4c58]" aria-hidden="true"></span>
                </template>

                <div :style="screenStyle" class="relative overflow-hidden bg-white" :class="phone ? `` : `h-full w-full`">
                    <slot :frame="frame" />

                    <template v-if="phone">
                        <!-- The camera, as the model wears it; drawn over the page because that is where the glass puts it. -->
                        <span
                            v-if="phone.cutout === `island`"
                            class="pointer-events-none absolute left-1/2 top-[11px] h-[30px] w-[112px] -translate-x-1/2 rounded-full bg-black"
                            aria-hidden="true"
                        ></span>
                        <span
                            v-else-if="phone.cutout === `notch`"
                            class="pointer-events-none absolute left-1/2 top-0 h-[30px] w-[160px] -translate-x-1/2 rounded-b-2xl bg-black"
                            aria-hidden="true"
                        ></span>
                        <span
                            v-else-if="phone.cutout === `punch`"
                            class="pointer-events-none absolute left-1/2 top-[10px] size-[11px] -translate-x-1/2 rounded-full bg-black"
                            aria-hidden="true"
                        ></span>

                        <!-- Difference blending is what makes one bar legible on a white page and on a black one, as the real indicator is. -->
                        <span
                            v-if="phone.cutout !== `none`"
                            class="pointer-events-none absolute bottom-[8px] left-1/2 h-[5px] w-[34%] -translate-x-1/2 rounded-full bg-white/60 mix-blend-difference"
                            aria-hidden="true"
                        ></span>
                    </template>
                </div>

                <!-- A home-button phone spends its forehead and chin on hardware, so the empty bezel would look like a bug. -->
                <template v-if="phone?.cutout === `none`">
                    <span
                        class="pointer-events-none absolute left-1/2 top-[26px] h-[5px] w-[46px] -translate-x-1/2 rounded-full bg-black/70"
                        aria-hidden="true"
                    ></span>
                    <span
                        class="pointer-events-none absolute bottom-[11px] left-1/2 size-[34px] -translate-x-1/2 rounded-full ring-1 ring-white/15"
                        aria-hidden="true"
                    ></span>
                </template>
            </div>
        </div>
    </div>
</template>
