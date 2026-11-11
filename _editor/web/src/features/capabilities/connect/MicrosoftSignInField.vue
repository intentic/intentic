<!-- A Microsoft card's sign-in, in place of a refresh-token box: the sandbox gets a one-time code from Microsoft, the
     person types it on Microsoft's own page in a new tab, and the sign-in lands in the form for the ordinary Save to
     store. Nobody asks the agent or pastes a token. Laid out like Connect Google (GoogleSignInField.vue), so the two read
     as one experience. A card whose declaration does not hold (an app with a secret) gets the plain box back. -->
<script setup lang="ts">
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { stashedToken } from "@intentic/sandbox-contract/schemas/capabilities";
import { BrandMark, Button, ui } from "@intentic/ui";
import { useCopied } from "@intentic/ui/clipboard";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { type ProcedureInput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { buildConfig } from "../../../models/capabilities/form";
import {
    type DeviceSignInCalls,
    grantedLine,
    MICROSOFT_MARK,
    type MicrosoftGrant,
    useDeviceSignIn,
} from "../../../models/capabilities/signIn/microsoftSignIn";

const t = useT();

const {
    tile,
    field,
    values,
    connection,
    kept = new Set<string>(),
    stored = false,
    alarm,
    calls = {
        // SAFETY: the form fills config by field, as strings; the daemon's schema coerces and refuses what does not fit,
        // in its own words, as the probe's input does (useCapabilities.ts, asDeclared).
        start: (input) => sandboxRpc.capabilities.deviceSignIn(input as ProcedureInput<`capabilities.deviceSignIn`>),
        wait: (flow) => sandboxRpc.capabilities.deviceSignInWait({ flow }),
    },
} = defineProps<{
    /** The tile: its fields build the config the sandbox signs in with, exactly as the probe's and the add's. */
    tile: CapabilityCatalogEntry;
    field: CapabilityField;
    /** The form's live answers: this row writes its own field (the stash marker) and reads the rest. */
    values: Record<string, string>;
    /** The connection being edited, whose kept credentials the sandbox fills in; undefined while adding one. */
    connection?: string | undefined;
    /** The credentials the connection being edited already holds. */
    kept?: ReadonlySet<string>;
    /** The connection being edited already holds a sign-in, which a blank answer keeps. */
    stored?: boolean;
    /** The red treatment, for a submit refused while nobody has signed in. */
    alarm?: string | undefined;
    /** Where the sign-in is asked: the sandbox, unless a test hands in its own. */
    calls?: DeviceSignInCalls;
}>();

const emit = defineEmits<{ left: [] }>();

const { phase, problem, begin, cancel } = useDeviceSignIn(calls);
const { copied, copy } = useCopied();

// The last sign-in here and the answers it was made with: it counts only while the form still holds its marker.
const grant = ref<MicrosoftGrant & { readonly answers: Readonly<Record<string, string>> }>();
const fresh = computed(() => (grant.value !== undefined && values[field.key] === grant.value.marker ? grant.value : undefined));
// A field the sign-in is bound to (tenant, client, access) changed since: Save would be refused, so it says so now.
const moved = computed(() => {
    const made = fresh.value;
    const key = made === undefined ? undefined : Object.keys(made.answers).find((name) => (values[name] ?? ``) !== made.answers[name]);
    return key === undefined ? undefined : (tile.fields.find((candidate) => candidate.key === key)?.label ?? key);
});
let showing = true;

const signIn = async (): Promise<void> => {
    const input: AddCapabilityInput = { id: connection ?? tile.id, kind: tile.kind, config: buildConfig(tile, values, kept) };
    const made = await begin(input);
    if (made === undefined || !showing) {
        return;
    }
    values[field.key] = made.marker;
    grant.value = { ...made, answers: Object.fromEntries(made.bound.map((key) => [key, values[key] ?? ``])) };
    emit(`left`);
};

// The page is Microsoft's own, opened beside this one; the code goes onto the clipboard on the way, since that page asks
// for it first.
const openPage = (event: MouseEvent): void => {
    if (phase.value.kind === `waiting`) {
        void copy(phase.value.code, event.currentTarget instanceof Element ? event.currentTarget : undefined);
    }
};
const copyCode = (event: MouseEvent): void => {
    if (phase.value.kind === `waiting`) {
        void copy(phase.value.code, event.currentTarget instanceof Element ? event.currentTarget : undefined);
    }
};

// What the box held before this row stood in for it (a pasted token, under another provider) is not this sign-in.
onMounted(() => {
    values[field.key] = ``;
});
// A marker is nothing to show in the box that comes back when this row goes (an app with a secret, another provider).
onBeforeUnmount(() => {
    showing = false;
    cancel();
    if (stashedToken(values[field.key]) !== undefined) {
        values[field.key] = ``;
    }
});

const status = computed(() => {
    if (phase.value.kind === `starting`) {
        return t(`capabilities.microsoftSignInField.gettingCode`);
    }
    return stored ? t(`capabilities.microsoftSignInField.signedIn`) : t(`capabilities.microsoftSignInField.opensMicrosoft`);
});
</script>

<template>
    <!-- A div, not a label: a label forwards every click inside it to its first control, which here starts a sign-in. -->
    <div class="ui-field">
        <span class="ui-field-label">
            {{ t(`capabilities.microsoftSignInField.microsoftAccount`) }}
            <Icon v-if="fresh || stored" name="check-circle" class="ml-1 text-2xs text-success" />
        </span>
        <!-- The code, Microsoft's page beside it, and the wait: everything the person needs without leaving this row. -->
        <div v-if="phase.kind === `waiting`" class="flex flex-col gap-1.5 rounded-lg bg-card px-3 py-2 shadow-sm">
            <span class="text-2xs text-muted">{{ t(`capabilities.microsoftSignInField.typeCode`) }}</span>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div class="flex items-center gap-1 rounded-md border border-line bg-canvas py-0.5 pl-2.5 pr-0.5">
                    <button
                        type="button"
                        class="font-mono text-sm font-semibold tracking-[0.2em] text-content"
                        :title="t(`capabilities.microsoftSignInField.copyCode`)"
                        @click="copyCode"
                    >
                        {{ phase.code }}
                    </button>
                    <!-- allow(recipes): A COPY GLYPH THAT SAYS "COPIED" for a beat after the press, as ConnectFlow's. -->
                    <button
                        type="button"
                        :aria-label="t(`capabilities.microsoftSignInField.copyCode`)"
                        :class="ui.iconButton({ tone: `subtle` }, copied && `w-auto px-1.5 text-success`)"
                        @click="copyCode"
                    >
                        <span class="flex items-center gap-1 text-2xs">
                            <Icon :name="copied ? `check` : `copy`" />
                            <span v-if="copied" aria-hidden="true">{{ t(`ui.action.copied`) }}</span>
                        </span>
                    </button>
                </div>
                <a
                    :href="phase.page"
                    target="_blank"
                    rel="noreferrer"
                    class="inline-flex items-center gap-1 text-xs text-link hover:underline"
                    @click="openPage"
                >
                    {{ t(`capabilities.microsoftSignInField.openPage`) }} <Icon name="external-link" />
                </a>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-subtle">
                    <Icon name="spinner" spin />{{ t(`capabilities.microsoftSignInField.waiting`) }}
                </span>
                <button type="button" :class="ui.textButton({ size: `xs` })" @click="cancel">
                    {{ t(`capabilities.microsoftSignInField.stopWaiting`) }}
                </button>
            </div>
        </div>
        <!-- Signed in, unless a Reconnect is getting its code (the button below then shows it loading). -->
        <div v-else-if="fresh && phase.kind !== `starting`" class="flex items-center gap-3 rounded-lg bg-card px-3 py-2 shadow-sm">
            <BrandMark :size="24" name="Microsoft" :art="MICROSOFT_MARK" />
            <span class="min-w-0 flex-1">
                <span class="block truncate text-xs text-content">
                    {{
                        fresh.who === undefined
                            ? t(`capabilities.microsoftSignInField.connected`)
                            : t(`capabilities.microsoftSignInField.connectedAs`, { who: fresh.who })
                    }}
                </span>
                <span class="block text-2xs text-muted">{{ grantedLine(fresh.granted) }}</span>
            </span>
            <button type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="signIn">
                {{ t(`capabilities.microsoftSignInField.reconnect`) }}
            </button>
        </div>
        <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
                :label="stored ? t(`capabilities.microsoftSignInField.reconnect`) : t(`capabilities.microsoftSignInField.signInWithMicrosoft`)"
                size="small"
                tier="boring"
                :loading="phase.kind === `starting`"
                @click="signIn"
            >
                <template #icon><BrandMark :size="14" name="Microsoft" :art="MICROSOFT_MARK" plain /></template>
            </Button>
            <span class="min-w-0 flex-1 text-2xs text-muted">{{ status }}</span>
        </div>
        <!-- One severity-ordered line below the control, like every other field on this form. -->
        <span v-if="problem" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ problem }}
        </span>
        <span v-else-if="moved" class="flex items-center gap-1 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.microsoftSignInField.changedSince`, { field: moved }) }}
        </span>
        <span v-else-if="alarm && !fresh && !stored" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.microsoftSignInField.signInFirst`) }}
        </span>
    </div>
</template>
