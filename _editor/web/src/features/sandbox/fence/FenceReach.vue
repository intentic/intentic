<!-- WHAT THE SANDBOX REACHES, DRAWN, so the dialog need not say it: one wire to the internet, which no fence stands on,
     and one to the private networks around its machine (the LAN, the machine itself, networks behind a VPN, cloud
     metadata), cut by the fence while it is on and passing an open gate while it is off. It follows the dialog's draft,
     so flipping the switch shows what the change means before it is saved. Every line sits on its lane's middle: the
     internet lane draws its edges as top borders of its lower half, the private lane as bottom borders of its upper
     half, so the branch, the wires and the elbow meet without a sub-pixel seam. -->
<script setup lang="ts">
import { Icon, toneDot } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const { fenced, machine } = defineProps<{
    /** Whether the draft fences the private networks off. */
    fenced: boolean;
    /** The machine the sandbox runs on, as the page names it: one of the places the fence covers. */
    machine: string;
}>();

const t = useT();

const WIRE = `border-muted`;
// The fence's two halves: joined into one bar across the wire while it is up, drawn back to two posts while it is open.
const GATE = `w-1 transition-all duration-300`;
const half = (end: `top` | `bottom`): string =>
    fenced ? toneDot(`primary`, `h-1/2`, end === `top` ? `rounded-t-full` : `rounded-b-full`) : `h-3 rounded-full bg-line-strong`;
</script>

<template>
    <figure class="flex items-center">
        <div class="flex w-18 shrink-0 flex-col items-center gap-1 rounded-xl border border-line-strong px-1.5 py-2.5 text-center">
            <Icon name="box" class="text-base text-content" aria-hidden="true" />
            <span class="text-2xs leading-tight text-muted">{{ t(`sandbox.networkFence.reachSandbox`) }}</span>
        </div>
        <span class="w-3 shrink-0 border-t" :class="WIRE" aria-hidden="true"></span>
        <div class="grid min-w-0 flex-1 grid-rows-2">
            <div class="flex min-w-0 items-stretch">
                <span class="h-1/2 w-3 shrink-0 self-end rounded-tl-lg border-l border-t" :class="WIRE" aria-hidden="true"></span>
                <span class="h-1/2 min-w-4 flex-1 self-end border-t" :class="WIRE" aria-hidden="true"></span>
                <span class="size-1.5 shrink-0 self-center rounded-full bg-muted" aria-hidden="true"></span>
                <div class="flex w-1/2 shrink-0 flex-col justify-center py-2 pl-3">
                    <span class="text-xs font-medium text-content">{{ t(`sandbox.networkFence.reachInternet`) }}</span>
                    <span class="text-2xs text-muted">{{ t(`sandbox.networkFence.reachAlways`) }}</span>
                </div>
            </div>
            <div class="flex min-w-0 items-stretch">
                <span class="h-1/2 w-3 shrink-0 self-start rounded-bl-lg border-b border-l" :class="WIRE" aria-hidden="true"></span>
                <span class="h-1/2 min-w-2 flex-1 self-start border-b" :class="WIRE" aria-hidden="true"></span>
                <!-- The fence: one bar across the wire while on; the same bar parted round it, an open gate, while off. -->
                <span class="flex h-10 shrink-0 flex-col justify-between self-center px-1.5" aria-hidden="true">
                    <span :class="[GATE, half(`top`)]"></span>
                    <span :class="[GATE, half(`bottom`)]"></span>
                </span>
                <span
                    class="h-1/2 min-w-2 flex-1 self-start border-b transition-colors duration-300"
                    :class="fenced ? `border-dashed border-line-strong` : WIRE"
                    aria-hidden="true"
                ></span>
                <span
                    class="size-1.5 shrink-0 self-center rounded-full transition-colors duration-300"
                    :class="fenced ? `border border-line-strong` : `bg-muted`"
                    aria-hidden="true"
                ></span>
                <div class="flex w-1/2 shrink-0 flex-col justify-center py-2 pl-3">
                    <span class="text-xs font-medium transition-colors duration-300" :class="fenced ? `text-muted` : `text-content`">
                        {{ t(`sandbox.networkFence.reachPrivate`) }}
                        <span class="sr-only">{{ fenced ? t(`sandbox.networkFence.reachRefused`) : t(`sandbox.networkFence.reachOpen`) }}</span>
                    </span>
                    <span class="text-2xs text-subtle">{{ t(`sandbox.networkFence.reachPrivateList`, { machine }) }}</span>
                </div>
            </div>
        </div>
    </figure>
</template>
