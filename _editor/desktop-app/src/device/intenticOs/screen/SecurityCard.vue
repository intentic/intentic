<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, inject, onMounted, ref } from "vue";
import type { OsLockStatus } from "../../../osSettings";
import { SECURITY_ACTIONS, securityActions } from "./security";

const t = useT();
const security = inject(SECURITY_ACTIONS, securityActions);
const status = ref<OsLockStatus>();
const reading = ref(true);
const busy = ref(false);
const problem = ref<string>();
const pin = ref(``);
const again = ref(``);
const minutes = ref(5);
const editing = ref(false);
const validPin = computed(() => /^[0-9]{4,12}$/.test(pin.value));
const matches = computed(() => pin.value === again.value);
const validMinutes = computed(() => Number.isInteger(minutes.value) && minutes.value >= 1 && minutes.value <= 240);

onMounted(async () => {
    try {
        status.value = (await security.status()) ?? undefined;
        minutes.value = status.value?.idleMinutes ?? 5;
    } catch {
        problem.value = `readFailure`;
    } finally {
        reading.value = false;
    }
});

const change = async (act: () => Promise<OsLockStatus>): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    problem.value = undefined;
    try {
        status.value = await act();
        minutes.value = status.value.idleMinutes;
        editing.value = false;
    } catch {
        problem.value = `changeFailure`;
    } finally {
        pin.value = ``;
        again.value = ``;
        busy.value = false;
    }
};

const savePin = (): void => {
    if (!validPin.value || !matches.value) {
        return;
    }
    const value = pin.value;
    pin.value = ``;
    again.value = ``;
    void change(() => security.setPin(value));
};
</script>

<template>
    <section class="flex flex-col gap-3 rounded-xl border border-line p-4" :aria-busy="reading || busy">
        <header class="flex items-start gap-2.5 text-sm">
            <Icon name="lock" class="shrink-0 text-subtle" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.security.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ t(`desktop.os.security.lead`) }}</p>
            </div>
        </header>
        <p v-if="reading" class="text-xs text-muted">{{ t(`desktop.os.security.loading`) }}</p>
        <Notice v-if="problem" tone="warning" class="text-xs">{{ t(`desktop.os.security.${problem}`) }}</Notice>
        <template v-if="status">
            <p class="text-xs text-muted">
                {{ status.enabled ? t(`desktop.os.security.on`, { minutes: status.idleMinutes }) : t(`desktop.os.security.off`) }}
            </p>
            <div v-if="!editing" class="flex flex-wrap gap-2">
                <Button
                    size="small"
                    :disabled="busy"
                    :label="t(status.enabled ? `desktop.os.security.change` : `desktop.os.security.set`)"
                    @click="editing = true"
                />
                <Button v-if="status.enabled" size="small" tier="boring" :disabled="busy" :label="t(`desktop.os.security.turnOff`)" @click="change(security.off)" />
            </div>
            <form v-else class="flex max-w-read-sm flex-col gap-2" @submit.prevent="savePin">
                <label class="flex flex-col gap-1 text-xs text-muted">
                    {{ t(`desktop.os.security.pin`) }}
                    <input v-model="pin" type="password" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="12" pattern="[0-9]{4,12}" :disabled="busy" :class="ui.input(`w-full`)" />
                </label>
                <label class="flex flex-col gap-1 text-xs text-muted">
                    {{ t(`desktop.os.security.repeat`) }}
                    <input v-model="again" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" :disabled="busy" :class="ui.input(`w-full`)" />
                </label>
                <p class="text-2xs text-subtle">{{ t(`desktop.os.security.pinHint`) }}</p>
                <p v-if="again && !matches" class="text-2xs text-warning">{{ t(`desktop.os.security.mismatch`) }}</p>
                <div class="flex gap-2">
                    <Button type="submit" size="small" :disabled="busy || !validPin || !matches" :label="t(`desktop.os.security.savePin`)" />
                    <Button type="button" size="small" tier="boring" :disabled="busy" :label="t(`ui.action.cancel`)" @click="editing = false; pin = ``; again = ``" />
                </div>
            </form>
            <form v-if="status.enabled" class="flex flex-wrap items-end gap-2" @submit.prevent="validMinutes && change(() => security.idle(minutes))">
                <label class="flex flex-col gap-1 text-xs text-muted">
                    {{ t(`desktop.os.security.idle`) }}
                    <input v-model.number="minutes" type="number" min="1" max="240" step="1" :disabled="busy" :class="ui.input(`w-24`)" />
                </label>
                <Button type="submit" size="small" :disabled="busy || !validMinutes || minutes === status.idleMinutes" :label="t(`desktop.os.security.saveIdle`)" />
            </form>
        </template>
    </section>
</template>
