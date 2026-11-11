<!-- A Custom MCP server's sign-in, in place of its token box while the server names an OAuth sign-in (mcpSignIn.ts):
     the server's own approval page in a window of its own, and the sign-in lands in the form for the ordinary Save to
     store. The sandbox registers itself, holds the tokens and renews them; nobody pastes one. Laid out like the Google
     and Microsoft sign-ins, so they read as one experience. "Paste a token instead" brings the box back. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { stashedToken } from "@intentic/sandbox-contract/schemas/capabilities";
import type { McpAuthCheck } from "@intentic/sandbox-contract/schemas/mcp-sign-in";
import { BrandMark, Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { grantedScopes, type McpGrant, type McpSignInCalls, SANDBOX_MCP_CALLS, storedSignIn, useMcpSignIn } from "../../../models/capabilities/signIn/mcpSignIn";

const t = useT();

const {
    field,
    values,
    instance,
    auth,
    stored = false,
    alarm,
    calls = SANDBOX_MCP_CALLS,
} = defineProps<{
    field: CapabilityField;
    /** The form's live answers: this row writes its own field (the stash marker) and reads `url`. */
    values: Record<string, string>;
    /** The connection being edited, whose sign-in this row shows until a new one replaces it; undefined while adding. */
    instance?: CapabilitySummary | undefined;
    /** What the address asks of a client, as the sandbox answered for it. */
    auth?: McpAuthCheck | undefined;
    /** The connection being edited already holds a credential, which a blank answer keeps. */
    stored?: boolean;
    /** The red treatment, for a submit refused while nobody has signed in. */
    alarm?: string | undefined;
    /** Where the sign-in is asked: the sandbox, unless a test hands in its own. */
    calls?: McpSignInCalls;
}>();

const emit = defineEmits<{ left: []; paste: [] }>();

const { phase, problem, begin, cancel } = useMcpSignIn(calls);

// The last sign-in here: it counts only while the form still holds its marker.
const grant = ref<McpGrant>();
const fresh = computed(() => (grant.value !== undefined && values[field.key] === grant.value.marker ? grant.value : undefined));
// The connection's own sign-in, while the form keeps it (a blank answer).
const kept = computed(() => (stored && (values[field.key] ?? ``) === `` ? storedSignIn(instance) : undefined));
const shown = computed(() => fresh.value ?? kept.value);
const url = computed(() => (values[`url`] ?? ``).trim());
// Signed in for another address than the form now holds: Save would keep a sign-in for the wrong server.
const moved = computed(() => shown.value !== undefined && shown.value.url !== `` && shown.value.url !== url.value);
// The authorization server registers no clients: the person makes one in its settings and brings its ID.
const needsClient = computed(() => auth?.auth === `oauth` && auth.registers === false);
const clientId = ref(``);
const server = computed(() => shown.value?.server ?? auth?.server);
// The server's own mark, where its address names a brand simple-icons carries (mcp.linear.app is Linear); the plug
// glyph otherwise.
const logo = computed(() => URL.parse(url.value)?.hostname.split(`.`).at(-2));
let showing = true;

const signIn = async (): Promise<void> => {
    const id = clientId.value.trim();
    const made = await begin({ url: url.value, clientId: id === `` ? undefined : id, keeping: instance?.id });
    if (made === undefined || !showing) {
        return;
    }
    values[field.key] = made.marker;
    grant.value = made;
    emit(`left`);
};

// What the box held before this row stood in for it (a token typed for another address) is not this sign-in.
onMounted(() => {
    if (stashedToken(values[field.key]) === undefined) {
        values[field.key] = ``;
    }
});
// A marker is nothing to show in the box that comes back when this row goes.
onBeforeUnmount(() => {
    showing = false;
    cancel();
    if (stashedToken(values[field.key]) !== undefined) {
        values[field.key] = ``;
    }
});

const status = computed(() => {
    if (stored && kept.value === undefined && fresh.value === undefined) {
        return t(`capabilities.mcpSignInField.holdsToken`);
    }
    return server.value === undefined ? t(`capabilities.mcpSignInField.opensServer`) : t(`capabilities.mcpSignInField.opens`, { server: server.value });
});
const granted = computed(() => {
    const words = grantedScopes(shown.value?.scope);
    return words === undefined ? t(`capabilities.mcpSignInField.accessUnstated`) : t(`capabilities.mcpSignInField.accessGranted`, { scopes: words });
});
</script>

<template>
    <!-- A div, not a label: a label forwards every click inside it to its first control, which here opens a window. -->
    <div class="ui-field">
        <span class="ui-field-label">
            {{ t(`capabilities.mcpSignInField.signInLabel`) }}
            <Icon v-if="shown" name="check-circle" class="ml-1 text-2xs text-success" />
        </span>
        <!-- Signed in, unless a Reconnect is under way: its waiting line and Stop take the row until it ends. -->
        <div v-if="shown && phase === `idle`" class="flex items-center gap-3 rounded-lg bg-card px-3 py-2 shadow-sm">
            <BrandMark :size="24" :name="shown.server" :logo="logo" icon="plug" />
            <span class="min-w-0 flex-1">
                <span class="block truncate text-xs text-content">
                    {{
                        shown.account === undefined
                            ? t(`capabilities.mcpSignInField.signedInTo`, { server: shown.server })
                            : t(`capabilities.mcpSignInField.connectedAs`, { who: shown.account })
                    }}
                </span>
                <span class="block truncate text-2xs text-muted">{{ granted }}</span>
            </span>
            <button type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" :disabled="phase !== `idle`" @click="signIn">
                {{ t(`capabilities.mcpSignInField.reconnect`) }}
            </button>
        </div>
        <template v-else>
            <input
                v-if="needsClient"
                v-model="clientId"
                :placeholder="t(`capabilities.mcpSignInField.clientId`)"
                :aria-label="t(`capabilities.mcpSignInField.clientId`)"
                :class="ui.input()"
            />
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button
                    :label="server === undefined ? t(`capabilities.mcpSignInField.signIn`) : t(`capabilities.mcpSignInField.signInTo`, { server })"
                    size="small"
                    tier="boring"
                    :loading="phase !== `idle`"
                    :disabled="needsClient && clientId.trim() === ``"
                    @click="signIn"
                >
                    <template #icon><BrandMark :size="14" :name="server ?? `MCP`" :logo="logo" icon="plug" plain /></template>
                </Button>
                <span v-if="phase === `waiting`" class="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-subtle">
                    <Icon name="spinner" spin />{{ t(`capabilities.mcpSignInField.waiting`, { server: server ?? url }) }}
                </span>
                <span v-else class="min-w-0 flex-1 text-2xs text-muted">{{ status }}</span>
                <button v-if="phase === `waiting`" type="button" :class="ui.textButton({ size: `xs` })" @click="cancel">
                    {{ t(`capabilities.mcpSignInField.stopWaiting`) }}
                </button>
                <button v-else type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="emit(`paste`)">
                    {{ t(`capabilities.mcpSignInField.pasteInstead`) }}
                </button>
            </div>
            <span v-if="needsClient" class="text-2xs text-muted">
                {{ t(`capabilities.mcpSignInField.clientIdHint`, { server: server ?? url, redirect: auth?.redirectUri ?? `` }) }}
            </span>
        </template>
        <!-- One severity-ordered line below the control, like every other field on this form. -->
        <span v-if="problem" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ problem }}
        </span>
        <span v-else-if="moved" class="flex items-center gap-1 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.mcpSignInField.addressChanged`) }}
        </span>
        <span v-else-if="fresh" class="text-2xs text-muted">{{ t(`capabilities.mcpSignInField.savingStores`) }}</span>
        <span v-else-if="alarm && !shown" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.mcpSignInField.signInFirst`) }}
        </span>
    </div>
</template>
