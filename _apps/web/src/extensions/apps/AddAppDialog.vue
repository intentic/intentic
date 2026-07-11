<script setup lang="ts">
import type { RepoApp, TemplateSummary } from "@intentic-app/api-contract";
import { Card } from "@intentic-app/ui";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import { computed, ref } from "vue";

/* The Add-an-app dialog — the single entry point for scaffolding apps, kept behind a modal so the view stays a
 * clean apps+tests list. Pick one or more templates from the source repo's templates.json and name each
 * instance (multiple instances of one template type are supported, each a unique slug that doesn't collide with
 * a present app). A pure picker: it emits the chosen entries and closes; AppsView owns the addApps kickoff and
 * the live install terminal. */

const props = defineProps<{ templates: TemplateSummary[]; apps: RepoApp[] }>();
const visible = defineModel<boolean>(`visible`, { default: false });
const emit = defineEmits<{ submit: [entries: { template: string; name: string }[]] }>();

// Template keys the user has checked, and their per-instance name overrides.
const selected = ref<string[]>([]);
const instanceNames = ref<Record<string, string>>({});

// Default instance name for a template, avoiding collisions with present apps (api, api-2, api-3, …).
const defaultName = (templateKey: string): string => {
    const existing = new Set(props.apps.map((app) => app.app));
    if (!existing.has(templateKey)) {
        return templateKey;
    }
    for (let i = 2; ; i++) {
        const candidate = `${templateKey}-${i}`;
        if (!existing.has(candidate)) {
            return candidate;
        }
    }
};

// Seed a default name when a template is checked; drop it when unchecked.
const onSelectionChange = (keys: string[]): void => {
    for (const key of keys) {
        if (!(key in instanceNames.value)) {
            instanceNames.value[key] = defaultName(key);
        }
    }
    for (const key of Object.keys(instanceNames.value)) {
        if (!keys.includes(key)) {
            delete instanceNames.value[key];
        }
    }
};

// Every checked template needs a non-empty, slug-valid name that collides with neither an existing app nor
// another pick in this batch.
const canAdd = computed(() => {
    if (selected.value.length === 0) {
        return false;
    }
    const existing = new Set(props.apps.map((app) => app.app));
    const seen = new Set<string>();
    for (const key of selected.value) {
        const name = (instanceNames.value[key] ?? key).trim();
        if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
            return false;
        }
        if (existing.has(name) || seen.has(name)) {
            return false;
        }
        seen.add(name);
    }
    return true;
});

const reset = (): void => {
    selected.value = [];
    instanceNames.value = {};
};

const submit = (): void => {
    if (!canAdd.value) {
        return;
    }
    emit(
        `submit`,
        selected.value.map((key) => ({ template: key, name: (instanceNames.value[key] ?? key).trim() })),
    );
    visible.value = false;
    reset();
};
</script>

<template>
    <Dialog
        v-model:visible="visible"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: '34rem' }"
        header="Add an app"
        @hide="reset"
    >
        <div class="flex flex-col gap-3">
            <p class="text-sm text-muted">Pick one or more templates to scaffold into this monorepo. Name each instance to run several of a kind.</p>
            <Card v-for="template in templates" :key="template.key" class="flex flex-col gap-2">
                <label class="flex cursor-pointer items-start gap-3">
                    <Checkbox
                        :model-value="selected"
                        :value="template.key"
                        @update:model-value="
                            (v: string[]) => {
                                selected = v;
                                onSelectionChange(v);
                            }
                        "
                    />
                    <span class="min-w-0">
                        <span class="block font-medium leading-tight">{{ template.label }}</span>
                        <span class="block text-xs text-muted">{{ template.description }}</span>
                    </span>
                </label>
                <!-- Name input shown when this template is checked. -->
                <div v-if="selected.includes(template.key)" class="ml-8 flex items-center gap-2">
                    <label class="text-xs text-muted">Name:</label>
                    <InputText v-model="instanceNames[template.key]" size="small" class="flex-1" placeholder="e.g. shop-api" />
                </div>
            </Card>
            <div class="flex justify-end">
                <Button label="Add" :disabled="!canAdd" @click="submit">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>
        </div>
    </Dialog>
</template>
