<!-- A route need's own answer: one person's leave for this sandbox to act as them in another of their sandboxes
     (docs/architecture/account-routing.md). The target admits anything but a report only beside a pairing secret that
     person minted there, so the press is theirs alone and runs from this editor, signed in to both: it mints the secret
     at the target under their session there, keeps it here, then answers the need, which the daemon meets once it holds
     the secret. Where both sandboxes speak s2s/1 no pairing is minted: the press makes the person's own contact between
     the two instead (components/contactPairing.ts), which the daemon meets the need by just the same. Anyone else reads
     whom it waits on. -->
<script setup lang="ts">
import { RAW_JSON_ROUTES } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import type { Need, RouteNeed } from "@intentic/sandbox-contract/schemas/needs";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../../components/ChatDecisionButton.vue";
import { useAuth } from "../../../client/auth/useAuth";
import { sandboxJson, sandboxJsonAt } from "../../../client/sandbox/sandboxClient";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useTier } from "../../../client/sandbox/useTier";
import { pairContact, pairPreferringContact, PERSON_ROUTE_GRANTS, ROUTE_ASKER_GRANTS, useContactPairingApi } from "../../../components/contactPairing";
import { useNeeds } from "../../../models/needs/useNeeds";
import { useNeedAnswer } from "../needAnswer";
import { farSandboxOf } from "./routeTarget";

const t = useT();

const props = defineProps<{ need: Need; subject: RouteNeed }>();

const needs = useNeeds();
const { user } = useAuth();
const { active, sandboxes } = useSandbox();
const { canShip } = useTier();
const contacts = useContactPairingApi();
// The leave is the person's own: the daemon's answer checks the same address.
const theirs = computed(() => user.value?.email.toLowerCase() === props.subject.person.toLowerCase());
const far = computed(() => farSandboxOf(sandboxes.value, props.subject));
const scopes = computed(() => props.subject.scopes.map((scope) => t(`needs.route.scopes.${scope}`)).join(`, `));

const JSON_POST = { method: `POST`, headers: { "content-type": `application/json` } } as const;

// The pairing minted at the target under the reader's session there; a target from before pairings has no such door.
const mintAt = async (target: { readonly id: string; readonly name: string }, from: string) => {
    try {
        return await sandboxJsonAt(target.id, rawRouteUrl(`POST /account/pairings`), RAW_JSON_ROUTES[`POST /account/pairings`].output, {
            ...JSON_POST,
            body: JSON.stringify({ from, fromName: active.value?.name ?? from }),
        });
    } catch (error) {
        throw error instanceof SandboxHttpError && error.status === 404 ? new Error(t(`needs.route.tooOld`, { target: target.name }), { cause: error }) : error;
    }
};

const { busy, notice, answer } = useNeedAnswer(() => props.need);
const allow = async (): Promise<void> => {
    const target = far.value;
    const from = props.subject.from;
    if (target === undefined || from === undefined) {
        return;
    }
    const id = props.need.id;
    await answer({
        failed: t(`needs.card.couldNotAnswer`),
        task: async () => {
            const tooOld = t(`needs.route.tooOld`, { target: target.name });
            await pairPreferringContact(
                supportsRoute(`POST /s2s/contacts/paired`),
                () => pairContact(contacts, { far: target, scope: `person`, here: ROUTE_ASKER_GRANTS, there: PERSON_ROUTE_GRANTS }, canShip.value, { tooOld }),
                async () => {
                    const minted = await mintAt(target, from);
                    await sandboxJson(rawRouteUrl(`POST /account/routes/secret`), { ...JSON_POST, body: JSON.stringify({ target: props.subject.target, secret: minted.secret }) });
                },
            );
            await needs.answer.mutateAsync({ id, answer: { kind: `approve` } });
        },
    });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">{{ t(`needs.route.lead`, { person: subject.person, target: subject.targetName, scopes }) }}</p>
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <template v-if="theirs">
                <ChatDecisionButton v-if="far && subject.from" tone="primary" icon="check" :disabled="busy" @click="allow">{{ t(`needs.route.approve`) }}</ChatDecisionButton>
                <span v-else-if="!subject.from" class="text-2xs text-subtle" data-route-old>{{ t(`needs.route.tooOld`, { target: active?.name ?? `` }) }}</span>
                <span v-else class="text-2xs text-subtle" data-route-unreachable>{{ t(`needs.route.unreachable`, { target: subject.targetName }) }}</span>
            </template>
            <span v-else class="text-2xs text-subtle" data-route-waits>{{ t(`needs.route.personOnly`, { person: subject.person }) }}</span>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
