<script setup lang="ts">
import type { InboundLinkSummary, InboundLinkTermsUpdate, LinkRequest, LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import { Button, CopyButton, InfoHint, Notice, Picker, type PickerOption, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useRoute } from "vue-router";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useMintedTokens } from "../../../workbench/operations/useMintedTokens";
import { usePersonas } from "../../../models/sandbox/personas/usePersonas";
import { LINKED_SANDBOXES_ANCHOR } from "../../../models/sandbox/sandboxNav";
import { inboundLinksChanged } from "../../../models/sandbox/useInboundLinks";

// INBOUND LINKS: the owner's other sandboxes allowed to hand this one tasks. Each link's terms are written here and
// enforced here: the persona its tasks wear, whether each waits for the owner, how many turns an hour it may start. A task
// that waits is answered on its link's row. Usually minted by the editor while pairing two sandboxes (the other sandbox's
// Linked sandbox card); minted here by hand, the token is shown once with this sandbox's address to paste over there.

const t = useT();
const { daemonUrl, active } = useSandbox();
const { canShip } = useRole();
const { personas } = usePersonas();

interface MintRequest {
    readonly label: string;
    readonly terms: LinkTerms;
}

const {
    tokens: links,
    minted,
    minting,
    notice,
    mint,
    forgetMinted,
    revoke,
} = useMintedTokens({
    list: async () => (await sandboxRaw(`GET /system/links`)).links,
    mint: async ({ label, terms }: MintRequest) => {
        const { token } = await sandboxRaw(`POST /system/links`, { input: { label, terms } });
        void inboundLinksChanged();
        return { token, label };
    },
    revoke: async (id) => {
        await sandboxRaw(`DELETE /system/links/{id}`, { params: { id } });
        void inboundLinksChanged();
        return undefined;
    },
    owner: () => active.value?.id,
    key: `access/links/mint`,
});

// A reader sent here by a task waiting on this sandbox's yes (sandboxNav.ts linkedSandboxesHref): the router scrolls to the hash
// before the links are read, so the section brings itself into view once it has them, once.
const route = useRoute();
const section = useTemplateRef<HTMLElement>(`section`);
const stopScroll = watch(
    () => [links.value.length, section.value] as const,
    ([count, element]) => {
        if (route.hash !== `#${LINKED_SANDBOXES_ANCHOR}` || count === 0 || element === null || element === undefined) {
            return;
        }
        void nextTick(() => element.scrollIntoView({ block: `start`, behavior: `smooth` }));
        stopScroll();
    },
);

// A link answered in place (new terms, a waiting task let through or declined): its row is the daemon's answer.
const replaced = shallowRef<Readonly<Record<string, InboundLinkSummary>>>({});
const shown = computed<readonly InboundLinkSummary[]>(() => links.value.map((link) => replaced.value[link.id] ?? link));
const rowNotice = shallowRef<ReturnType<typeof noticeFrom>>();
const settle = async (id: string, answer: () => Promise<InboundLinkSummary>, failed: string): Promise<void> => {
    rowNotice.value = undefined;
    try {
        const link = await answer();
        replaced.value = { ...replaced.value, [id]: link };
        // The count on the Programs tab and the Map's lines read the shared entry, which this answer just made stale.
        void inboundLinksChanged();
    } catch (caught) {
        rowNotice.value = noticeFrom(caught, failed);
    }
};

const NO_PERSONA = ``;
const personaOptions = computed<readonly PickerOption<string>[]>(() => [
    { value: NO_PERSONA, label: t(`sandbox.linkedSandboxes.noPersona`), hint: t(`sandbox.linkedSandboxes.noPersonaHint`) },
    ...personas.value.map((persona) => ({ value: persona.id, label: persona.label ?? persona.id })),
]);
const personaName = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : (personas.value.find((persona) => persona.id === id)?.label ?? id);

const termsLine = (terms: LinkTerms): string =>
    [
        terms.actsAs === undefined
            ? t(`sandbox.linkedSandboxes.wearsNothing`)
            : t(`sandbox.linkedSandboxes.wears`, { persona: personaName(terms.actsAs) ?? `` }),
        terms.approve ? t(`sandbox.linkedSandboxes.eachWaits`) : t(`sandbox.linkedSandboxes.startsAtOnce`),
        t(`sandbox.linkedSandboxes.perHour`, { count: terms.turnsPerHour }),
    ].join(` · `);

const describe = (link: InboundLinkSummary): string =>
    [
        termsLine(link.terms),
        t(`sandbox.linkedSandboxes.conversations`, { count: link.conversations }, link.conversations),
        link.lastUsedAt === undefined
            ? t(`sandbox.linkedSandboxes.neverUsed`)
            : t(`sandbox.linkedSandboxes.usedAgo`, { ago: timeAgo(link.lastUsedAt, { days: true }) }),
    ].join(` · `);

const askedLine = (request: LinkRequest): string =>
    `${request.task.replace(/\s+/g, ` `).slice(0, 160)} · ${t(`sandbox.linkedSandboxes.askedAgo`, { ago: timeAgo(request.askedAt, { days: true }) })}`;

const decide = (link: InboundLinkSummary, request: LinkRequest, approve: boolean): Promise<void> =>
    settle(
        link.id,
        () => sandboxRaw(`POST /system/links/{id}/requests/{request}`, { params: { id: link.id, request: request.id }, input: { approve } }),
        t(`sandbox.linkedSandboxes.couldntAnswer`),
    );

// One link's terms, edited in place under its row.
const editing = ref<string>();
const draft = ref<{ actsAs: string; approve: boolean; turnsPerHour: number }>({ actsAs: NO_PERSONA, approve: false, turnsPerHour: 20 });
const edit = (link: InboundLinkSummary): void => {
    if (editing.value === link.id) {
        editing.value = undefined;
        return;
    }
    editing.value = link.id;
    draft.value = { actsAs: link.terms.actsAs ?? NO_PERSONA, approve: link.terms.approve, turnsPerHour: link.terms.turnsPerHour };
};
const save = async (link: InboundLinkSummary): Promise<void> => {
    const { actsAs, approve, turnsPerHour } = draft.value;
    const input: InboundLinkTermsUpdate = { approve, turnsPerHour };
    if (actsAs !== NO_PERSONA) {
        input.actsAs = actsAs;
    }
    await settle(link.id, () => sandboxRaw(`POST /system/links/{id}`, { params: { id: link.id }, input }), t(`sandbox.linkedSandboxes.couldntSave`));
    editing.value = undefined;
};

// A link minted by hand, for a sandbox the editor cannot pair from here: asked for with the group's New link, since most
// links are made by pairing from the other side, and closed on a mint, whose token then stands in its place.
const creating = ref(false);
const startCreate = (): void => {
    forgetMinted();
    creating.value = true;
};
const label = ref(``);
const actsAs = ref<string | undefined>(NO_PERSONA);
const approve = ref(true);
const submit = async (): Promise<void> => {
    const named = label.value.trim();
    if (named === `` || minting.value) {
        return;
    }
    const terms: LinkTerms = { approve: approve.value, turnsPerHour: 20 };
    if (actsAs.value !== undefined && actsAs.value !== NO_PERSONA) {
        terms.actsAs = actsAs.value;
    }
    await mint({ label: named, terms });
    if (minted.value !== undefined) {
        label.value = ``;
        creating.value = false;
    }
};
const address = computed(() => daemonUrl.value ?? ``);
</script>

<template>
    <section v-if="canShip" :id="LINKED_SANDBOXES_ANCHOR" ref="section" class="scroll-mt-4">
        <RowGroup
            data-setting="access-linked-sandboxes"
            :label="t(`sandbox.linkedSandboxes.title`)"
        >
            <template #info>
                <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.linkedSandboxes.title`) })">
                    <span class="block text-xs text-content">{{ t(`sandbox.linkedSandboxes.explain`) }}</span>
                </InfoHint>
            </template>
            <template #actions>
                <Button v-if="!creating" :label="t(`sandbox.linkedSandboxes.newLink`)" size="small" tier="boring" @click="startCreate">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </template>

            <!-- What was asked for sits first, under the press that asked: the form, then the token it minted, shown once. -->
            <RowNote v-if="creating || minted || notice" variant="block">
                <div class="flex flex-col gap-3">
                    <Notice v-if="notice" :of="notice" />
                    <form v-if="creating" class="flex flex-wrap items-center gap-2" @submit.prevent="submit">
                        <input
                            v-model="label"
                            type="text"
                            autocomplete="off"
                            autofocus
                            :placeholder="t(`sandbox.linkedSandboxes.labelPlaceholder`)"
                            :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)"
                        />
                        <Picker
                            v-model="actsAs"
                            :options="personaOptions"
                            variant="input"
                            :aria-label="t(`sandbox.linkedSandboxes.persona`)"
                            :header="t(`sandbox.linkedSandboxes.persona`)"
                            class="ui-field-sm w-44"
                        />
                        <label class="flex items-center gap-2 text-xs text-content">
                            <ToggleSwitch v-model="approve" class="ui-switch-sm" />
                            {{ t(`sandbox.linkedSandboxes.askMeFirst`) }}
                        </label>
                        <div class="ml-auto flex items-center gap-2">
                            <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="minting" @click="creating = false" />
                            <Button
                                type="submit"
                                :label="t(`sandbox.linkedSandboxes.createLink`)"
                                size="small"
                                :loading="minting"
                                :disabled="minting || label.trim() === ``"
                            >
                                <template #icon><Icon name="link" /></template>
                            </Button>
                        </div>
                    </form>
                    <div v-if="minted" class="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                        <div class="flex items-start gap-2">
                            <p class="flex-1 text-2xs text-subtle">{{ t(`sandbox.linkedSandboxes.shownOnce`) }}</p>
                            <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)" @click="forgetMinted">
                                {{ t(`ui.action.done`) }}
                            </button>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="w-20 shrink-0 text-2xs text-subtle">{{ t(`sandbox.linkedSandboxes.address`) }}</span>
                            <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ address }}</code>
                            <CopyButton :text="address" :label="t(`ui.action.copy`)" />
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="w-20 shrink-0 text-2xs text-subtle">{{ t(`sandbox.linkedSandboxes.token`) }}</span>
                            <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ minted.token }}</code>
                            <CopyButton :text="minted.token" :label="t(`ui.action.copy`)" />
                        </div>
                    </div>
                </div>
            </RowNote>

            <template v-for="link in shown" :key="link.id">
                <Row icon="link" :title="link.label" :description="describe(link)">
                    <template v-if="link.requests.length > 0" #meta>
                        <StatusBadge
                            variant="warning"
                            :label="t(`sandbox.linkedSandboxes.waiting`, { count: link.requests.length }, link.requests.length)"
                            size="xs"
                        />
                    </template>
                    <template #control>
                        <Button :label="t(`sandbox.linkedSandboxes.terms`)" size="small" tier="quiet" @click="edit(link)" />
                        <Button :label="t(`ui.action.revoke`)" size="small" tier="quiet" tone="danger" @click="revoke(link.id)" />
                    </template>
                </Row>
                <!-- A task that waits for the owner, answered where it waits: nothing of it has run yet. -->
                <Row
                    v-for="request in link.requests"
                    :key="`${link.id}/${request.id}`"
                    icon="clock"
                    class="pl-6"
                    :title="request.title ?? t(`sandbox.linkedSandboxes.aTask`)"
                    :description="askedLine(request)"
                >
                    <template #control>
                        <Button :label="t(`sandbox.linkedSandboxes.allow`)" size="small" @click="decide(link, request, true)" />
                        <Button
                            :label="t(`sandbox.linkedSandboxes.decline`)"
                            size="small"
                            tier="quiet"
                            tone="danger"
                            @click="decide(link, request, false)"
                        />
                    </template>
                </Row>
                <RowNote v-if="editing === link.id" variant="block">
                    <form class="flex flex-col gap-3" @submit.prevent="save(link)">
                        <div class="flex flex-wrap items-center gap-3">
                            <Picker
                                v-model="draft.actsAs"
                                :options="personaOptions"
                                variant="input"
                                :aria-label="t(`sandbox.linkedSandboxes.persona`)"
                                :header="t(`sandbox.linkedSandboxes.persona`)"
                                class="ui-field-sm w-48"
                            />
                            <label class="flex items-center gap-2 text-sm text-content">
                                <ToggleSwitch v-model="draft.approve" class="ui-switch-sm" />
                                {{ t(`sandbox.linkedSandboxes.askMeFirst`) }}
                            </label>
                            <label class="flex items-center gap-2 text-sm text-content">
                                <input
                                    v-model.number="draft.turnsPerHour"
                                    type="number"
                                    min="1"
                                    max="120"
                                    :class="ui.input({ size: `sm` }, `w-20`)"
                                />
                                {{ t(`sandbox.linkedSandboxes.turnsAnHour`) }}
                            </label>
                            <Button type="submit" :label="t(`ui.action.save`)" size="small" />
                        </div>
                    </form>
                </RowNote>
            </template>

            <!-- An answer on a link's row that was refused (new terms, a task let through or declined), under the rows. -->
            <RowNote v-if="rowNotice" variant="block"><Notice :of="rowNotice" /></RowNote>
            <!-- No link, and none being made: how one is usually made, so the empty card is not a blank. -->
            <RowNote v-if="shown.length === 0 && !creating && !minted" variant="empty">{{ t(`sandbox.linkedSandboxes.empty`) }}</RowNote>
        </RowGroup>
    </section>
</template>
