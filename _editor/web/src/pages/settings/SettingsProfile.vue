<script setup lang="ts">
import { Avatar, ui, RowGroup, RowNote } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, nextTick, ref } from "vue";
import { fileToSquareDataUrl } from "../../composables/imageDataUrl";
import { useAuth } from "../../composables/useAuth";

/* Profile: display name + avatar, saved via Better Auth's update-user (useAuth.updateProfile). The avatar is a
 * live control (pick → save immediately, like the sandbox logo on /sandbox); the name is inline-editable with
 * the same pencil / check / cancel affordances as the sandbox name on that page. */

const { user, updateProfile } = useAuth();

const avatarInput = ref<HTMLInputElement | null>(null);
const avatarBusy = ref(false);
const avatarError = ref<string | undefined>(undefined);

const editing = ref(false);
const name = ref(``);
const nameInput = ref<HTMLInputElement | null>(null);
const nameTouched = ref(false);
const nameBusy = ref(false);
const nameError = ref<string | undefined>(undefined);

const nameValidationError = computed<string | undefined>(() => {
    const trimmed = name.value.trim();
    if (trimmed.length === 0) {
        return `Name is required.`;
    }
    if (trimmed.length > 60) {
        return `Name must be 60 characters or fewer.`;
    }
    return undefined;
});
const canSaveName = computed(() => {
    const trimmed = name.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && trimmed !== user.value?.name;
});

const subline = computed<{ text: string; tone: string }>(() => {
    if (avatarError.value !== undefined) {
        return { text: avatarError.value, tone: `text-danger` };
    }
    if (nameError.value !== undefined) {
        return { text: nameError.value, tone: `text-danger` };
    }
    if (editing.value && nameTouched.value && nameValidationError.value !== undefined) {
        return { text: nameValidationError.value, tone: `text-danger` };
    }
    if (editing.value) {
        return { text: `Enter saves · Esc cancels.`, tone: `text-muted` };
    }
    return { text: ``, tone: `text-muted` };
});

const pickAvatar = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    if (file === undefined) {
        return;
    }
    avatarError.value = undefined;
    avatarBusy.value = true;
    let square: string;
    try {
        square = await fileToSquareDataUrl(file, `cover`);
    } catch {
        avatarError.value = `Couldn't read that file as an image.`;
        avatarBusy.value = false;
        return;
    }
    try {
        await updateProfile({ image: square });
    } catch (error) {
        avatarError.value = errorMessage(error, `Profile update failed.`);
    } finally {
        avatarBusy.value = false;
    }
};

const startEdit = async (): Promise<void> => {
    name.value = user.value?.name ?? ``;
    nameError.value = undefined;
    nameTouched.value = false;
    editing.value = true;
    await nextTick();
    nameInput.value?.select();
};

const cancelEdit = (): void => {
    editing.value = false;
    nameError.value = undefined;
};

const saveName = async (): Promise<void> => {
    const trimmed = name.value.trim();
    if (nameBusy.value || !canSaveName.value) {
        return;
    }
    nameBusy.value = true;
    nameError.value = undefined;
    try {
        await updateProfile({ name: trimmed });
        editing.value = false;
    } catch (error) {
        nameError.value = errorMessage(error, `Profile update failed.`);
    } finally {
        nameBusy.value = false;
    }
};
</script>

<template>
    <RowGroup label="Profile">
        <RowNote variant="block">
            <div class="flex min-w-0 items-center gap-3">
                <button
                    type="button"
                    :disabled="avatarBusy"
                    aria-label="Change avatar"
                    v-tooltip.bottom="`Change avatar`"
                    class="group relative h-14 w-14 shrink-0 cursor-pointer rounded-full"
                    @click="avatarInput?.click()"
                >
                    <Avatar :size="56" :src="user?.image" :name="user?.name" />
                    <span
                        class="absolute inset-0 flex items-center justify-center rounded-full bg-canvas/70 text-content transition-opacity"
                        :class="avatarBusy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'"
                    >
                        <Icon :name="avatarBusy ? `spinner` : `camera`" :spin="avatarBusy" class="text-base" />
                    </span>
                </button>
                <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="pickAvatar" />

                <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                        <div class="flex min-w-0 items-center">
                            <div class="grid w-fit min-w-0 max-w-full grid-cols-1 grid-rows-1">
                                <template v-if="editing">
                                    <span
                                        aria-hidden="true"
                                        class="invisible col-start-1 row-start-1 flex h-8 min-w-0 items-center truncate rounded-md border border-transparent px-2 text-base font-medium"
                                        >{{ name === `` ? ` ` : name }}</span
                                    >
                                    <input
                                        ref="nameInput"
                                        v-model="name"
                                        type="text"
                                        aria-label="Display name"
                                        autocomplete="off"
                                        maxlength="60"
                                        class="ui-field-box col-start-1 row-start-1 h-8 w-full min-w-0 px-2 text-base font-medium"
                                        :class="nameTouched && nameValidationError ? 'ui-field-error-box' : ''"
                                        @blur="nameTouched = true"
                                        @keydown.enter.prevent="saveName"
                                        @keydown.esc.prevent="cancelEdit"
                                    />
                                </template>
                                <h2
                                    v-else
                                    class="col-start-1 row-start-1 flex h-8 items-center rounded-md border border-transparent px-2 text-base font-medium"
                                >
                                    <span class="truncate">{{ user?.name ?? `Account` }}</span>
                                </h2>
                            </div>

                            <div class="flex shrink-0 items-center gap-1">
                                <template v-if="editing">
                                    <button
                                        type="button"
                                        :class="ui.iconButton(`h-8 w-8 text-subtle hover:text-success`)"
                                        :disabled="nameBusy || !canSaveName"
                                        aria-label="Save display name"
                                        v-tooltip.bottom="`Save · Enter`"
                                        v-action="saveName"
                                    >
                                        <Icon :name="nameBusy ? `spinner` : `check`" :spin="nameBusy" />
                                    </button>
                                    <button
                                        type="button"
                                        :class="ui.iconButton(`h-8 w-8 text-subtle`)"
                                        :disabled="nameBusy"
                                        aria-label="Cancel rename"
                                        v-tooltip.bottom="`Cancel · Esc`"
                                        @click="cancelEdit"
                                    >
                                        <Icon name="times" />
                                    </button>
                                </template>
                                <button
                                    v-else
                                    type="button"
                                    :class="ui.iconButton(`h-8 w-8 text-subtle`)"
                                    aria-label="Rename display name"
                                    v-tooltip.bottom="`Rename display name`"
                                    v-action="startEdit"
                                >
                                    <Icon name="pencil" class="text-xs" />
                                </button>
                            </div>
                        </div>
                    </div>
                    <p v-if="subline.text" class="h-4 truncate px-2 text-xs leading-4" :class="subline.tone">{{ subline.text }}</p>
                </div>
            </div>
        </RowNote>
    </RowGroup>
</template>
