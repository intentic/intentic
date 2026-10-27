<script setup lang="ts">
import { Button, Notice, type NoticeModel, SegmentedControl, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ProcedureOutput } from "../../../../client/sandbox/sandboxRpc";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useKeyrings, useTypeInto } from "./useKeyrings";

// The owner's Type into…: this one secret typed into whatever has focus on one of their computers, through its keyring,
// after a countdown that leaves time to put the cursor there. The countdown runs on that computer (the route waits it
// out before typing); the one drawn here keeps time beside it, so the person knows when to have the cursor in place. The
// keyring still checks the window and still asks when the entry's share says to; what comes back is where it went, or the
// sentence it was refused with.

type Typed = ProcedureOutput<`secrets.typeInto`>;

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();

const { online } = useKeyrings();
const { typeInto } = useTypeInto();

// Three seconds by default: enough to click into a window, short enough that focus has not wandered off again.
// Keyed by its spelling, since a segmented control's values are strings.
const COUNTDOWNS = { "3": 3, "5": 5, "10": 10 } as const;
type Countdown = keyof typeof COUNTDOWNS;
const COUNTDOWN_ORDER: readonly Countdown[] = [`3`, `5`, `10`];
const countdownOptions = computed(() =>
    COUNTDOWN_ORDER.map((key) => ({ label: t(`capabilities.typeInto.seconds`, { seconds: COUNTDOWNS[key] }), value: key })),
);
const countdown = ref<Countdown>(`3`);
const seconds = computed(() => COUNTDOWNS[countdown.value]);

const device = ref<string | undefined>(undefined);
// The computer that holds a device row's value is the first guess, where it answers; otherwise the first that does.
watch(
    online,
    (keyrings) => {
        if (device.value !== undefined && keyrings.some((keyring) => keyring.machine === device.value)) {
            return;
        }
        const home = row.entry.device?.machine;
        device.value = keyrings.find((keyring) => keyring.machine === home)?.machine ?? keyrings[0]?.machine;
    },
    { immediate: true },
);

const phase = ref<`choose` | `counting` | `typing` | `typed` | `refused`>(`choose`);
const left = ref(0);
const typed = ref<Typed | undefined>(undefined);
const error = ref<NoticeModel | undefined>(undefined);
let ticking: ReturnType<typeof setInterval> | undefined;
const stopTicking = (): void => {
    if (ticking !== undefined) {
        clearInterval(ticking);
        ticking = undefined;
    }
};
onBeforeUnmount(stopTicking);

const type = async (): Promise<void> => {
    const machine = device.value;
    if (machine === undefined || phase.value === `counting` || phase.value === `typing`) {
        return;
    }
    error.value = undefined;
    typed.value = undefined;
    left.value = seconds.value;
    phase.value = seconds.value > 0 ? `counting` : `typing`;
    stopTicking();
    ticking = setInterval(() => {
        left.value = Math.max(0, left.value - 1);
        if (left.value === 0 && phase.value === `counting`) {
            phase.value = `typing`;
            stopTicking();
        }
    }, 1000);
    try {
        typed.value = await typeInto.mutateAsync({ key: row.entry.key, device: machine, countdownSeconds: seconds.value });
        phase.value = `typed`;
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.typeInto.couldNotType`, { machine }));
        phase.value = `refused`;
    } finally {
        stopTicking();
    }
};

const working = computed(() => phase.value === `counting` || phase.value === `typing`);
// The countdown and the typing are this panel's own busy state, drawn on its button; the press only starts them, so the
// button's own lock (held for as long as a returned promise) does not outlast the answer.
const start = (): void => {
    void type();
};
const typedSentence = computed(() => {
    const answer = typed.value;
    if (answer === undefined) {
        return ``;
    }
    const where =
        answer.field === `password`
            ? t(`capabilities.typeInto.typedPassword`, { program: answer.program })
            : t(`capabilities.typeInto.typedText`, { program: answer.program });
    return answer.asked ? `${where} ${t(`capabilities.typeInto.asked`, { machine: device.value ?? `` })}` : where;
});
</script>

<template>
    <!-- Drawn on the panel that hangs off the row's Type into… press, which is its surface: nothing here draws a box. -->
    <section class="flex flex-col gap-3" :aria-label="t(`capabilities.typeInto.title`)">

        <!-- Nothing to type on: said, with what brings one back, rather than a picker with nothing in it. -->
        <p v-if="online.length === 0 && phase === `choose`" class="text-xs text-muted">{{ t(`capabilities.typeInto.noneOnline`) }}</p>

        <template v-else>
            <div v-if="online.length > 1" class="flex flex-wrap items-center gap-1" role="group" :aria-label="t(`capabilities.typeInto.which`)">
                <button
                    v-for="keyring of online"
                    :key="keyring.machine"
                    type="button"
                    :class="ui.chip({ on: device === keyring.machine })"
                    :aria-pressed="device === keyring.machine"
                    :disabled="working"
                    @click="device = keyring.machine"
                >
                    <Icon name="desktop" class="text-2xs" />{{ keyring.machine }}
                </button>
            </div>

            <div v-if="!working" class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span class="text-xs text-muted">{{ t(`capabilities.typeInto.wait`) }}</span>
                <SegmentedControl v-model="countdown" :options="countdownOptions" size="xs" />
            </div>

            <p v-if="phase === `counting`" class="text-xs text-content" role="status">
                {{ t(`capabilities.typeInto.counting`, { machine: device ?? ``, seconds: left }) }}
            </p>
            <p v-else-if="phase === `typing`" class="text-xs text-content" role="status">
                {{ t(`capabilities.typeInto.typing`, { machine: device ?? `` }) }}
            </p>
            <p v-else-if="phase === `typed`" class="flex items-start gap-1.5 text-xs text-content" role="status">
                <Icon name="check" class="shrink-0 text-success" />
                <span>{{ typedSentence }}</span>
            </p>
            <p v-else class="text-xs text-muted">{{ t(`capabilities.typeInto.explain`, { machine: device ?? ``, seconds }) }}</p>

            <Notice v-if="error" :of="error" />

            <div class="flex items-center justify-end border-t border-line-subtle pt-3">
                <Button
                    size="small"
                    tier="accent"
                    :label="phase === `typed` || phase === `refused` ? t(`capabilities.typeInto.again`) : t(`capabilities.typeInto.type`)"
                    :disabled="working || device === undefined"
                    :loading="working"
                    @click="start"
                />
            </div>
        </template>
    </section>
</template>
