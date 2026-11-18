<script setup lang="ts">
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { roleBoundsWords, profilesHolding } from "../../../models/sandbox/roles/roleBounds";
import { Button, FACE_SIZES, InlineRename, Modal, Notice, type NoticeModel, RoleFace, SearchBar, Section, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { roleSlug, rolesStartingIn } from "../../../models/sandbox/roles/roleRules";
import { useRoles } from "../../../models/sandbox/roles/useRoles";
import { useAccessProfiles } from "../../../models/sandbox/access/useAccessProfiles";
import { here, page } from "../../../lib/routes/links";
import { useT } from "@intentic/ui/i18n";

// Who works in this folder, opened from a directory row: write a new role starting here, or point an existing one at
// this folder (which MOVES it, since a role has one starting folder). One that already starts here is renamed in
// place. What a card may reach is not asked here: it is the access profiles listing it, set on Access ▸ Profiles, and
// its badge reads them. Every save is a whole-card upsert; a field this panel doesn't ask about is carried over, not
// dropped.

const t = useT();

const dir = defineModel<string | undefined>({ required: true });

const { roles, save } = useRoles();
// The badge beside a card says how bounded the profiles holding it make it; none for a card no profile holds.
const { profiles } = useAccessProfiles();
const heldBy = (role: Role) => profilesHolding(profiles.value, role.id);

// Open exactly when there's a folder to be open about — one flag, so there's no open-with-no-folder state.
const visible = computed({
    get: () => dir.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            dir.value = undefined;
        }
    },
});
const folderName = computed(() => dir.value?.split(`/`).pop() ?? ``);
const cards = computed<Role[]>(() => (dir.value === undefined ? [] : rolesStartingIn(roles.value, dir.value)));

// Mode drives the lower section (heading, fields, button verb) from one piece of state.
// `chosen` is cleared entering the other mode, so a picked card can't leak into a name submission.
type Mode = `new` | `existing`;
const mode = ref<Mode>(`new`);
// Id of the card pointed at this folder (existing).
const chosen = ref<string | undefined>(undefined);
const filter = ref(``);
const label = ref(``);
// The one line a new chat is matched on (Role.brief); "" is a card with none, stored as absent.
const brief = ref(``);
const saveError = ref<NoticeModel | undefined>(undefined);

const startAdd = (): void => {
    mode.value = `new`;
    chosen.value = undefined;
    filter.value = ``;
    label.value = ``;
    brief.value = ``;
    saveError.value = undefined;
};
const startExisting = (): void => {
    mode.value = `existing`;
    chosen.value = undefined;
    filter.value = ``;
    saveError.value = undefined;
};

// A second folder must not inherit the first one's half-typed name or a previous save failure.
watch(dir, () => {
    startAdd();
});

// Every role that doesn't already start here (elsewhere, or nowhere); the ones that do are the list above,
// so offering them again would be a no-op.
const elsewhere = computed<Role[]>(() => roles.value.filter((role) => role.workspace?.startIn !== dir.value));
const query = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() =>
    query.value === ``
        ? elsewhere.value
        : elsewhere.value.filter((role) => `${role.label ?? ``} ${role.id}`.toLowerCase().includes(query.value)),
);
// Filter earns its place only past a glance-length list, same threshold as the Roles page's account chooser.
const filterable = computed(() => elsewhere.value.length > 6);
const chosenCard = computed(() => roles.value.find((role) => role.id === chosen.value));
// Where the chosen card starts today, if anywhere; stated aloud since the folder losing it isn't shown on this screen.
const movedFrom = computed(() => chosenCard.value?.workspace?.startIn);

const cardId = computed(() => roleSlug(label.value));
// A new card can't land on a taken name — save is by id, so it would silently overwrite that other role.
const taken = computed(() => mode.value === `new` && roles.value.some((role) => role.id === cardId.value));
const nameValid = computed(() => cardId.value !== `` && !taken.value);
const valid = computed(() => (mode.value === `existing` ? chosen.value !== undefined : nameValid.value));
const nameHint = computed(() => {
    if (label.value === `` || nameValid.value) {
        return undefined;
    }
    return taken.value ? t(`workspace.directoryRoles.nameTaken`, { id: cardId.value }) : t(`workspace.directoryRoles.useLettersOrDigits`);
});

const heading = computed(() =>
    mode.value === `existing` ? t(`workspace.directoryRoles.useExisting`) : t(`workspace.directoryRoles.addARole`),
);

// The whole card about to be written, or undefined until the form describes one. Built here so the two modes'
// shapes sit side by side: moving a card touches one field, writing one spells out every field it owns.
const draftCard = (folder: string): Role | undefined => {
    if (mode.value === `existing`) {
        const picked = chosenCard.value;
        // A move, not a re-decision: everything but `startIn` stays exactly as the picked card already has it.
        return picked === undefined ? undefined : { ...picked, workspace: { ...picked.workspace, startIn: folder } };
    }
    if (!nameValid.value) {
        return undefined;
    }
    const named = label.value.trim();
    const said = brief.value.trim();
    const card: Role = {
        id: cardId.value,
        // A brand-new card starts with no accounts.
        capabilities: [],
        // The panel's whole point: the clicked folder.
        workspace: { startIn: folder },
    };
    // Only stored when it says something the id doesn't already.
    if (named !== `` && named !== cardId.value) {
        card.label = named;
    }
    if (said !== ``) {
        card.brief = said;
    }
    return card;
};

// A card already starting here, renamed where its row shows it: the id stays, so nothing that names the card loses it.
// A refusal stays in the name's field.
const rename = async (role: Role, name: string): Promise<void> => {
    const { label: _label, ...rest } = role;
    await save.mutateAsync(name === role.id ? rest : { ...rest, label: name });
};

const submitting = ref(false);
const submit = async (): Promise<void> => {
    const folder = dir.value;
    const card = folder === undefined ? undefined : draftCard(folder);
    // `dir` is cleared only once the write lands, so without the flag every Enter until then starts another save.
    if (card === undefined || submitting.value || !valid.value) {
        return;
    }
    saveError.value = undefined;
    submitting.value = true;
    try {
        await save.mutateAsync(card);
        dir.value = undefined;
    } catch (err) {
        saveError.value = noticeFrom(err, t(`workspace.directoryRoles.couldNotSave`));
    } finally {
        submitting.value = false;
    }
};
</script>

<template>
    <!-- The header asks the folder's question, not claims its contents: "Roles in X" reads as an existing list, wrong on the folder's first use. -->
    <Modal v-model:open="visible" size="md" :header="t(`workspace.directoryRoles.whoWorksIn`, { folderName })">
        <template #description>
            {{ t(`workspace.directoryRoles.roleStartsHereOpens`) }} <code class="ui-code">{{ dir }}</code
            >. Everything else about it can stay as it is.
        </template>

        <div class="flex flex-col gap-4">
            <!-- Existing cards first, since a folder can hold several; absent entirely (not an empty box) when there are none. -->
            <Section v-if="cards.length > 0" :label="t(`workspace.directoryRoles.startingHere`)">
                <div class="flex flex-col gap-1">
                    <!-- Rows on the dialog's ground, reaching out by their padding so faces line up with the label. Each is renamed
                         where it is read; its badge says how bounded the access profiles holding it make it. -->
                    <div v-for="role in cards" :key="role.id" class="-mx-2.5 flex flex-col gap-2 rounded-lg px-2.5 py-1.5">
                        <div class="flex items-center gap-2.5">
                            <!-- The list size: this panel is about the folder, but a face too small to read is no cheaper, just worse. -->
                            <RoleFace :role :size="FACE_SIZES.row" />
                            <InlineRename
                                :value="role.label ?? role.id"
                                :write="(name: string) => rename(role, name)"
                                :label="t(`shared.name`)"
                                :action="t(`ui.action.rename`)"
                                :failure="t(`workspace.directoryRoles.couldNotSave`)"
                                class="min-w-0 flex-1 text-sm text-content"
                            />
                            <StatusBadge v-if="heldBy(role).length > 0" variant="neutral" size="xs">{{
                                roleBoundsWords(heldBy(role))
                            }}</StatusBadge>
                        </div>
                    </div>
                </div>
            </Section>

            <!-- Only drawn when there are cards above to separate from; alone, a rule under one paragraph reads as a load failure. -->
            <Section :label="heading" :class="cards.length > 0 ? `border-t border-line pt-4` : ``">
                <!-- Always the same corner, and only ever one link at a time — two side by side would turn this into a three-way choice. -->
                <template v-if="mode !== `new` || elsewhere.length > 0" #actions>
                    <button v-if="mode !== `new`" type="button" :class="ui.textButton({ tone: `quiet` })" @click="startAdd">
                        {{ t(`workspace.directoryRoles.addNewOneInstead`) }}
                    </button>
                    <button v-else type="button" :class="ui.textButton({ tone: `quiet` })" @click="startExisting">
                        {{ t(`workspace.directoryRoles.useOneIAlready`) }}
                    </button>
                </template>
                <div class="flex flex-col gap-3">
                    <!-- Rows styled like the ones above on purpose — same kind of thing, one folder along. -->
                    <template v-if="mode === `existing`">
                        <SearchBar
                            v-if="filterable"
                            v-model="filter"
                            variant="field"
                            clearable
                            :placeholder="t(`workspace.directoryRoles.findRole`)"
                            :aria-label="t(`workspace.directoryRoles.findRole2`)"
                        />
                        <!-- Pulled out by the rows' padding on the scroller itself, since it clips anything that reaches past its edge. -->
                        <div class="-mx-2.5 flex max-h-56 flex-col gap-1 overflow-y-auto">
                            <button
                                v-for="role in shown"
                                :key="role.id"
                                type="button"
                                class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors"
                                :class="chosen === role.id ? `ui-row-select-on` : `ui-row-select`"
                                :aria-label="t(`workspace.directoryRoles.startHere`, { id: role.label ?? role.id })"
                                :aria-pressed="chosen === role.id"
                                @click="chosen = role.id"
                            >
                                <RoleFace :role :size="FACE_SIZES.row" />
                                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ role.label ?? role.id }}</span>
                                <span class="max-w-[45%] shrink-0 truncate text-xs text-subtle">
                                    {{
                                        role.workspace?.startIn === undefined
                                            ? t(`workspace.directoryRoles.noStartingFolder`)
                                            : t(`workspace.directoryRoles.startsIn2`, { startIn: role.workspace.startIn })
                                    }}
                                </span>
                                <Icon v-if="chosen === role.id" name="check" class="shrink-0 text-xs text-link" />
                            </button>
                            <p v-if="shown.length === 0" class="px-2.5 py-1 text-xs text-subtle">
                                {{ t(`workspace.directoryRoles.noRoleGoesBy`) }}
                            </p>
                        </div>
                        <!-- Stated in words too, since the folder that loses the card isn't shown on this screen. -->
                        <p v-if="movedFrom !== undefined" class="text-xs text-warning">
                            {{ t(`workspace.directoryRoles.moves`) }} <span class="font-medium">{{ chosenCard?.label ?? chosenCard?.id }}</span>
                            {{ t(`workspace.directoryRoles.startsIn`) }} <code class="ui-code">{{ movedFrom }}</code>
                            {{ t(`workspace.directoryRoles.todayRoleOneStarting`) }}
                        </p>
                    </template>

                    <template v-else>
                        <div class="ui-field">
                            <input
                                v-model="label"
                                :class="ui.input('w-full font-medium')"
                                :placeholder="t(`workspace.directoryRoles.nameRoleDocsBot`, { folderName })"
                                :aria-label="t(`shared.name`)"
                                autofocus
                                @keyup.enter="submit()"
                            />
                            <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
                        </div>

                        <!-- The one line a new chat is matched on, the same field the full editor opens with. -->
                        <div class="ui-field">
                            <input
                                v-model="brief"
                                :class="ui.input('w-full')"
                                maxlength="200"
                                :placeholder="t(`sandbox.roleForm.backendWorkOnApi`)"
                                :aria-label="t(`sandbox.roleForm.what`)"
                                @keyup.enter="submit()"
                            />
                        </div>
                        <!-- What it may reach is not asked here: a quiet line says where it is set. -->
                        <p class="text-xs text-subtle">{{ t(`workspace.directoryRoles.reachOnAccess`) }}</p>
                    </template>

                    <Notice v-if="saveError !== undefined" :of="saveError" />
                </div>
            </Section>
        </div>

        <template #footer>
            <!-- The rest of a card lives on the page that owns it; this link is the way there, not a second copy of it. -->
            <RouterLink :to="here(page.sandboxSettings(`roles`))" :class="ui.textButton({ tone: `quiet` }, 'mr-auto')">
                {{ t(`workspace.directoryRoles.fullEditor`) }} <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="dir = undefined" />
            <!-- The verb follows the mode, so the button never promises "add" while the panel is actually moving a card. -->
            <Button
                tier="accent"
                :label="mode === `new` ? t(`workspace.directoryRoles.addRole`) : t(`workspace.directoryRoles.startHere2`)"
                :loading="save.isPending.value"
                :disabled="!valid"
                @click="submit"
            >
                <template #icon><Icon :name="mode === `new` ? `plus` : `check`" /></template>
            </Button>
        </template>
    </Modal>
</template>
