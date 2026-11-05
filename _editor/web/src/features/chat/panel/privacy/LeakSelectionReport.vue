<script setup lang="ts">
import { PERSONAL_DATA_CLASSES, type PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";
import type { PrivacyLeakReport } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { AnchoredOverlay, Button, Icon, Notice, Picker, placeAnchored, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { type SelectedLeak, selectedLeak } from "./leakSelection";
import { shortKindNames } from "../../../../models/sandbox/privacyKinds";
import { useLeakReport } from "../../../../models/sandbox/usePrivacyLeaks";
import { shieldRefusal, usePrivacyShield } from "../../../../models/sandbox/usePrivacyShield";

// "SHOULD HAVE BEEN MASKED": a value selected in one message of this transcript, reported as a leak from where it was
// read (schemas/privacy-leaks.ts). Its exact value is masked from then on; the text around it goes with it, so the owner
// reads it where it stood. Offered only while the shield runs, since with it off nothing is masked and nothing "should
// have been". Anybody may try: one who does not run the shield is told so by the daemon's refusal, said in the popover,
// rather than the press being hidden on a guess. One small press beside the selection; it goes with the selection, a
// scroll or Escape.

const t = useT();

const { root, conversationId } = defineProps<{
    // The transcript's scroller: where a selection counts, and whose scroll takes the press away.
    root: HTMLElement | null;
    conversationId: string;
}>();

const { status } = usePrivacyShield();
const { report, reporting, reportError, resetReport } = useLeakReport();

const watching = computed(() => root !== null && status.value !== undefined && status.value.policy.mode !== `off`);

const picked = shallowRef<SelectedLeak>();
const open = ref(false);
const kind = ref<PersonalDataClass>(`person-name`);
const done = ref(false);

const SHORT = computed(shortKindNames);
const KIND_OPTIONS = computed(() => PERSONAL_DATA_CLASSES.map((each) => ({ value: each, label: SHORT.value[each] })));

const refusal = computed(() =>
    shieldRefusal(reportError.value, t(`sandbox.agentPrivacyShield.leaks.report.notYours`), t(`sandbox.agentPrivacyShield.leaks.report.failed`)),
);

// THE PRESS, placed under the selection's end once it has a size; parked off-screen until then, as AnchoredOverlay parks.
const chip = ref<HTMLButtonElement>();
const placed = ref<{ readonly left: number; readonly top: number }>();
const chipStyle = computed<CSSProperties>(() =>
    placed.value === undefined
        ? { transform: `translate(-200vw, -200vh)` }
        : { left: `${Math.round(placed.value.left)}px`, top: `${Math.round(placed.value.top)}px` },
);
const place = async (): Promise<void> => {
    placed.value = undefined;
    await nextTick();
    const box = chip.value;
    const at = picked.value;
    const view = box?.ownerDocument.defaultView;
    if (box === undefined || at === undefined || view === null || view === undefined) {
        return;
    }
    const size = box.getBoundingClientRect();
    const where = placeAnchored({
        anchor: at.rect,
        box: { width: size.width, height: size.height },
        view: { width: view.innerWidth, height: view.innerHeight },
        side: `bottom`,
        cross: `end`,
        gap: 6,
        edge: 8,
    });
    placed.value = { left: where.left, top: where.top };
};
watch(picked, place);

const hide = (): void => {
    picked.value = undefined;
};

// A selection is read once it stops moving: at the pointer's release, or a beat after the last keyboard change.
const SETTLE_MS = 120;
let pressing = false;
let settling: ReturnType<typeof setTimeout> | undefined;
const settle = (): void => {
    clearTimeout(settling);
    settling = setTimeout(() => {
        if (!open.value && root !== null && watching.value) {
            picked.value = selectedLeak(root);
        }
    }, SETTLE_MS);
};

// While the popover is open the selection is its own business (a click inside collapses it), so it is let be.
const onSelectionChange = (): void => {
    if (open.value) {
        return;
    }
    hide();
    if (!pressing) {
        settle();
    }
};
const onPointerDown = (event: PointerEvent): void => {
    pressing = !(event.target instanceof Node && chip.value?.contains(event.target) === true);
};
const onPointerUp = (): void => {
    if (pressing) {
        pressing = false;
        settle();
    }
};
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && !open.value) {
        hide();
    }
};
// A scroll moves the text from under the press; an open popover stays, since a reply streaming in scrolls by itself.
const onScroll = (): void => {
    if (!open.value) {
        hide();
    }
};

let armed: { readonly doc: Document; readonly scroller: HTMLElement } | undefined;
const disarm = (): void => {
    clearTimeout(settling);
    if (armed !== undefined) {
        armed.doc.removeEventListener(`selectionchange`, onSelectionChange);
        armed.doc.removeEventListener(`pointerdown`, onPointerDown, true);
        armed.doc.removeEventListener(`pointerup`, onPointerUp, true);
        armed.doc.removeEventListener(`keydown`, onKeydown);
        armed.scroller.removeEventListener(`scroll`, onScroll);
        armed = undefined;
    }
    open.value = false;
    hide();
};
const arm = (scroller: HTMLElement): void => {
    const doc = scroller.ownerDocument;
    doc.addEventListener(`selectionchange`, onSelectionChange);
    doc.addEventListener(`pointerdown`, onPointerDown, true);
    doc.addEventListener(`pointerup`, onPointerUp, true);
    doc.addEventListener(`keydown`, onKeydown);
    scroller.addEventListener(`scroll`, onScroll, { passive: true });
    armed = { doc, scroller };
};
watch(
    () => (watching.value ? root : null),
    (scroller) => {
        disarm();
        if (scroller !== null) {
            arm(scroller);
        }
    },
    { immediate: true },
);
// Another conversation in this pane: what was selected in the last one is not this one's to report.
watch(
    () => conversationId,
    () => {
        open.value = false;
        hide();
    },
);
onBeforeUnmount(disarm);

// Closed by Escape, a click elsewhere or a report said: the next selection starts clean.
watch(open, (now) => {
    if (!now) {
        done.value = false;
        resetReport();
        hide();
    }
});

const send = async (): Promise<void> => {
    const leak = picked.value;
    if (leak === undefined || reporting.value) {
        return;
    }
    done.value = false;
    const sent: PrivacyLeakReport = { value: leak.value, class: kind.value, conversationId };
    if (leak.context !== undefined) {
        sent.context = leak.context;
    }
    done.value = (await report(sent)) !== undefined;
};
</script>

<template>
    <Teleport v-if="picked !== undefined && root !== null" :to="root.ownerDocument.body">
        <button
            ref="chip"
            type="button"
            :class="ui.overlayChip(`fixed z-50 bg-overlay shadow-md`)"
            :style="chipStyle"
            :aria-label="t(`chat.leakSelectionReport.action`)"
            :aria-expanded="open"
            aria-haspopup="dialog"
            @mousedown.prevent
            @click="open = !open"
        >
            <Icon name="shield" class="text-2xs" />
            <span>{{ t(`chat.leakSelectionReport.action`) }}</span>
        </button>
    </Teleport>
    <AnchoredOverlay v-model="open" :anchor="chip" side="bottom" cross="end">
        <form class="flex w-64 max-w-full flex-col gap-2 p-3" @submit.prevent="send">
            <p class="truncate font-mono text-xs text-content">{{ picked?.value }}</p>
            <p class="text-2xs text-muted">{{ t(`chat.leakSelectionReport.note`) }}</p>
            <div class="flex items-center justify-between gap-2">
                <Picker
                    v-model="kind"
                    :options="KIND_OPTIONS"
                    variant="ghost"
                    :aria-label="t(`sandbox.agentPrivacyShield.leaks.report.kind`)"
                    :header="t(`sandbox.agentPrivacyShield.leaks.report.kind`)"
                />
                <Button size="small" tier="accent" type="submit" :disabled="reporting || done">{{ t(`sandbox.agentPrivacyShield.leaks.report.submit`) }}</Button>
            </div>
            <p v-if="done" aria-live="polite" class="text-2xs text-success">{{ t(`sandbox.agentPrivacyShield.leaks.report.done`) }}</p>
            <Notice v-if="refusal !== undefined" :of="refusal" size="sm" />
        </form>
    </AnchoredOverlay>
</template>
