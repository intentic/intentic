<script setup lang="ts">
import type { IntenticOsWifiNetwork } from "@intentic/sandbox-contract/schemas/intentic-os";
import { Button, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, ref } from "vue";
import { asksPassword, networksShown, onlineOf, strengthOf, type Strength } from "./networkCard";
import { asking, forgetWifi, joining, joinWifi, network, scanWifi, setWifiRadio, stopAsking, wifi, wifiChanging, wifiError, wifiScanning } from "./settings";

// THE NETWORK, on This computer when this computer runs Intentic OS (settings.ts holds it, the app's os_settings.rs runs
// `ic os network`): how it is online, Wi-Fi on or off, and the networks in reach with how strong each is and whether it
// is locked. A press on one joins it; a locked one this computer has not joined before asks for its password first, and
// a wrong one asks again. A network joined before can be forgotten. The networks are looked for as the card opens and at
// the reader's word, never on a timer: a look takes the adapter seconds.

const t = useT();

onMounted(() => void scanWifi());

/** How many networks show before "Show all": a busy street has dozens. */
const FIRST = 6;

const online = computed(() => (network.value === undefined ? undefined : onlineOf(network.value)));
const STRENGTH_WORDS = { 1: `weak`, 2: `fair`, 3: `good`, 4: `strong` } as const satisfies Record<Strength, string>;
const strengthWord = (strength: Strength): string => t(`desktop.os.network.strength.${STRENGTH_WORDS[strength]}`);
const summary = computed(() => {
    const now = online.value;
    if (now === undefined || now.kind === `offline`) {
        return t(`desktop.os.network.offline`);
    }
    if (now.kind === `wired`) {
        return t(`desktop.os.network.wired`);
    }
    const name = now.name === undefined ? t(`desktop.os.network.wifi`) : t(`desktop.os.network.wifiTo`, { name: now.name });
    return now.strength === undefined ? name : `${name} · ${strengthWord(now.strength)}`;
});

const all = ref(false);
const shown = computed(() => (wifi.value === undefined ? [] : networksShown(wifi.value)));
const listed = computed(() => (all.value ? shown.value : shown.value.slice(0, FIRST)));
const busy = computed(() => joining.value !== undefined || wifiChanging.value);

/* THE PASSWORD, typed here and out of this page at the press: the app hands it to ic on its standard input. */
const password = ref(``);
const reveal = ref(false);

const join = (picked: IntenticOsWifiNetwork): void => {
    if (asksPassword(picked)) {
        password.value = ``;
        asking.value = { ssid: picked.ssid, wrong: false };
        return;
    }
    void joinWifi(picked.ssid);
};
const joinWith = (ssid: string): void => {
    if (password.value === ``) {
        return;
    }
    // Out of the page at the press, whether the network takes it or not.
    const given = password.value;
    password.value = ``;
    void joinWifi(ssid, given);
};
const cancel = (): void => {
    password.value = ``;
    stopAsking();
};
const radio = (on: boolean): void => {
    void setWifiRadio(on);
};
</script>

<template>
    <section class="flex flex-col gap-3 rounded-xl border border-line p-4" :aria-busy="busy || wifiScanning">
        <header class="flex items-start gap-2.5 text-sm">
            <Icon :name="online?.kind === `wired` ? `link` : `wifi`" class="shrink-0" :class="online?.kind === `offline` ? `text-subtle` : `text-link`" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.network.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ summary }}</p>
            </div>
            <!-- Wi-Fi on or off: only on a computer that has it. -->
            <label v-if="wifi?.adapter" class="flex shrink-0 items-center gap-2 text-xs text-content">
                <span>{{ t(`desktop.os.network.wifiLabel`) }}</span>
                <ToggleSwitch :model-value="wifi.enabled" :disabled="busy" :aria-label="t(`desktop.os.network.wifiLabel`)" @update:model-value="radio" />
            </label>
        </header>

        <p v-if="wifi && !wifi.adapter" class="text-2xs text-subtle">{{ t(`desktop.os.network.noAdapter`) }}</p>
        <p v-else-if="wifi && !wifi.enabled" class="text-2xs text-subtle">{{ t(`desktop.os.network.off`) }}</p>

        <!-- THE NETWORKS IN REACH: the one in use, those joined before, the rest; each with its strength and its lock. -->
        <template v-else-if="wifi">
            <ul v-if="listed.length > 0" class="flex flex-col divide-y divide-line">
                <li v-for="each in listed" :key="each.ssid" class="flex flex-col gap-2 py-2">
                    <div class="flex items-center gap-2.5">
                        <!-- Four bars, as many lit as the signal is strong. -->
                        <span class="flex h-3 shrink-0 items-end gap-px" role="img" :aria-label="strengthWord(strengthOf(each.signal))">
                            <span
                                v-for="bar in 4"
                                :key="bar"
                                class="w-1 rounded-sm"
                                :class="[[`h-1`, `h-1.5`, `h-2`, `h-3`][bar - 1], bar <= strengthOf(each.signal) ? `bg-content` : `bg-content/20`]"
                            />
                        </span>
                        <span class="min-w-0 flex-1 truncate text-xs text-content">{{ each.ssid }}</span>
                        <Icon v-if="each.secured" name="lock" class="shrink-0 text-2xs text-subtle" v-tooltip.top="t(`desktop.os.network.locked`)" />
                        <span v-if="each.active" class="shrink-0 text-2xs font-medium text-success">{{ t(`desktop.os.network.connected`) }}</span>
                        <template v-else>
                            <span v-if="each.known" class="shrink-0 text-2xs text-subtle">{{ t(`desktop.os.network.saved`) }}</span>
                            <Button
                                size="small"
                                tier="boring"
                                :label="joining === each.ssid ? t(`desktop.os.network.joining`) : t(`desktop.os.network.join`)"
                                :loading="joining === each.ssid"
                                :disabled="busy"
                                @click="join(each)"
                            />
                        </template>
                        <button
                            v-if="each.known || each.active"
                            type="button"
                            :class="ui.textButton({ tone: `subtle`, size: `xs` }, `shrink-0`)"
                            :disabled="busy"
                            :aria-label="t(`desktop.os.network.forgetOf`, { name: each.ssid })"
                            @click="forgetWifi(each.ssid)"
                        >
                            {{ t(`desktop.os.network.forget`) }}
                        </button>
                    </div>

                    <!-- Its password, asked for before the first join, and again after a wrong one. -->
                    <form v-if="asking?.ssid === each.ssid" class="flex flex-col gap-2 pl-6" @submit.prevent="joinWith(each.ssid)">
                        <p v-if="asking.wrong" class="text-2xs text-warning">{{ t(`desktop.os.network.wrongPassword`) }}</p>
                        <div class="flex flex-wrap items-center gap-2">
                            <input
                                v-model="password"
                                :type="reveal ? `text` : `password`"
                                autocomplete="off"
                                :placeholder="t(`desktop.os.network.password`, { name: each.ssid })"
                                :aria-label="t(`desktop.os.network.password`, { name: each.ssid })"
                                :class="ui.input(`min-w-0 flex-1`)"
                            />
                            <Button size="small" :label="t(`desktop.os.network.join`)" :disabled="password === `` || busy" @click="joinWith(each.ssid)" />
                            <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" :disabled="busy" @click="cancel" />
                        </div>
                        <label class="flex items-center gap-2 text-2xs text-muted">
                            <input v-model="reveal" type="checkbox" class="accent-primary-600" />
                            <span>{{ t(`desktop.os.network.show`) }}</span>
                        </label>
                    </form>
                </li>
            </ul>
            <p v-else-if="!wifiScanning" class="text-2xs text-subtle">{{ t(`desktop.os.network.none`) }}</p>
        </template>

        <Notice v-if="wifiError" tone="warning" class="text-2xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="wifiError = undefined">
            <span class="block font-medium">{{
                wifiError.ssid === undefined ? t(`desktop.os.network.didntChange`) : t(`desktop.os.network.couldNotJoin`, { name: wifiError.ssid })
            }}</span>
            <span v-if="wifiError.reason" class="mt-0.5 block font-mono break-words">{{ wifiError.reason }}</span>
        </Notice>

        <footer v-if="wifi === undefined || (wifi.adapter && wifi.enabled)" class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-2.5">
            <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="wifiScanning || busy" @click="scanWifi">
                <Icon :name="wifiScanning ? `spinner` : `refresh`" :spin="wifiScanning" class="shrink-0" />
                <span>{{ wifiScanning ? t(`desktop.os.network.looking`) : t(`desktop.os.network.lookAgain`) }}</span>
            </button>
            <button v-if="!all && shown.length > FIRST" type="button" :class="ui.textButton({ tone: `quiet` })" @click="all = true">
                <Icon name="chevron-down" class="shrink-0" />
                <span>{{ t(`desktop.os.network.showAll`, { count: shown.length }) }}</span>
            </button>
        </footer>
    </section>
</template>
