<!-- AN ADDRESS A SANDBOX ALREADY ANSWERS ON, in the new sandbox's form (useAddAttach.ts): the address, then why it could
     not be connected, each refusal naming the one thing the reader can do about it. The press is the form's own. -->
<script setup lang="ts">
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useAuth } from "../../../client/auth/useAuth";
import { webOriginOf } from "../flow/installCommand";
import type { AddAttach } from "./useAddAttach";

const { attach } = defineProps<{ attach: AddAttach }>();
const emit = defineEmits<{ submit: [] }>();

const t = useT();
const { user } = useAuth();
const { domain, attachToken, outcome, originHelp, normalizedDomain, domainProblem } = attach;
const webOrigin = webOriginOf(globalThis.location.origin);
</script>

<template>
    <div class="flex flex-col gap-3" data-add-sandbox-attach>
        <p class="text-xs text-muted">{{ t(`setup.setup.alreadyRunningSandboxContainer`) }}</p>
        <label class="ui-field">
            <span class="ui-field-label">{{ t(`shared.domain`) }}</span>
            <input
                v-model="domain"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="sandbox.example.com"
                :class="ui.input('w-full')"
                data-add-sandbox-domain
                @keydown.enter.prevent="emit(`submit`)"
            />
            <span v-if="domainProblem" class="text-xs text-warning">{{ domainProblem }}</span>
            <span v-else-if="normalizedDomain" class="text-xs text-muted"
                >{{ t(`setup.setup.wellConnectTo`) }} <span>{{ normalizedDomain }}</span
                >.</span
            >
            <span v-else class="text-xs text-muted">{{ t(`setup.setup.httpsAddressSandboxAlready`) }}</span>
        </label>

        <!-- Two checks anyone can make, then the one that needs a variable they may never have set. -->
        <Notice v-if="outcome?.kind === `unreachable`" :of="{ tone: `danger`, title: t(`setup.setup.nothingAnswered`) }">
            <span class="mt-0.5 block text-2xs">{{ t(`setup.setup.checkSandboxRunningDomain`) }}</span>
            <button v-if="!originHelp" type="button" :class="ui.textButton({ size: `xs` }, `mt-1`)" @click="originHelp = true">
                {{ t(`setup.setup.checkedBothStillNothing`) }}
            </button>
            <i18n-t v-else keypath="setup.setup.webOriginMustName" tag="span" class="mt-1 block text-2xs" scope="global">
                <template #variable><code>WEB_ORIGIN</code></template>
                <template #origin
                    ><span>{{ webOrigin ?? PLATFORM_WEB_ORIGIN }}</span></template
                >
            </i18n-t>
        </Notice>
        <Notice
            v-else-if="outcome?.kind === `timeout`"
            :of="{ tone: `danger`, title: t(`setup.setup.acceptedNeverAnswered`), detail: t(`setup.setup.acceptedNeverAnsweredDetail`) }"
        />
        <Notice v-else-if="outcome?.kind === `no-origin`" :of="{ tone: `danger`, title: t(`setup.setup.domainLiveNoSandbox`) }">
            <span class="mt-0.5 block text-2xs">
                {{ t(`setup.setup.tunnelReverseProxyAnswered`) }} {{ outcome.status }} {{ t(`setup.setup.nothingToForwardTo`) }}.
            </span>
        </Notice>
        <template v-else-if="outcome?.kind === `needs-token`">
            <Notice :of="{ tone: `warning`, title: t(`setup.setup.sandboxUpNotLetIn`) }">
                <span class="mt-0.5 block text-2xs"
                    >{{ t(`setup.setup.waitingToClaimedConnection`) }} <code>CONNECT_TOKEN</code> {{ t(`setup.setup.toClaimYours`) }}</span
                >
            </Notice>
            <label class="ui-field">
                <span class="ui-field-label">{{ t(`setup.setup.connectionToken`) }}</span>
                <input
                    v-model="attachToken"
                    type="password"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    :placeholder="t(`setup.setup.connectTokenSandboxRuns`)"
                    :class="ui.input('w-full')"
                    @keydown.enter.prevent="emit(`submit`)"
                />
                <span class="text-xs text-muted">{{ t(`setup.setup.usedOnceToClaim`) }}</span>
            </label>
        </template>
        <Notice
            v-else-if="outcome?.kind === `denied`"
            :of="{
                tone: `danger`,
                title: outcome.message,
                detail: user?.email ? t(`setup.setup.askOwnerToInvite`, { email: user.email }) : t(`setup.setup.askOwnerToInviteYou`),
            }"
        />
        <Notice
            v-else-if="outcome?.kind === `rejected`"
            :of="{ tone: `danger`, title: t(`setup.setup.sandboxRefusedConnection`), detail: outcome.message }"
        />
    </div>
</template>
