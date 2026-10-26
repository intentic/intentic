<script setup lang="ts">
import { Button, FilterBar, Modal, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { Disposable } from "@intentic/extension-api";
import { installApp, installOffered } from "../../workbench/commands/appInstall";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";
import { categoryLabel } from "../../workbench/commands/categories";
import { rankCommands } from "../../workbench/commands/commandSearch";
import { formatChord, isApplePlatform } from "../../workbench/commands/keybindings";
import { commands } from "../../workbench/commands/useCommands";
import { effectiveKeybinding } from "../../workbench/commands/useKeymap";
import { inAppWindow } from "../../workbench/commands/windowKind";

// The sheet of every shortcut this window answers right now (Mod+/), by family: the registry's live commands with the
// chord each fires on here, a person's own remaps included. Settings › Keyboard is where they change; this is where
// they are read, without leaving the screen. A command with no chord, or no surface mounted to run it, is not listed.

const t = useT();
const router = useRouter();
const open = ref(false);
const query = ref(``);
const isMac = isApplePlatform();
const appWindow = inAppWindow();

let registration: Disposable | undefined;
onMounted(() => {
    registration = registerBuiltin(`workbench.shortcuts`, () => {
        query.value = ``;
        open.value = true;
    });
});
onUnmounted(() => registration?.dispose());

interface Family {
    readonly name: string;
    readonly rows: readonly { readonly command: string; readonly title: string; readonly keys: string }[];
}

const families = computed<readonly Family[]>(() => {
    const bound = commands.value.flatMap((entry) => {
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        return chord === undefined ? [] : [{ entry, keys: formatChord(chord, isMac) }];
    });
    const ranked = rankCommands(
        bound.map(({ entry }) => entry),
        query.value,
    );
    const keysOf = new Map(bound.map(({ entry, keys }) => [entry.command, keys]));
    const byFamily = new Map<string, Family[`rows`][number][]>();
    for (const entry of ranked) {
        const name = entry.category === undefined ? `` : categoryLabel(entry.category);
        byFamily.set(name, [...(byFamily.get(name) ?? []), { command: entry.command, title: entry.title, keys: keysOf.get(entry.command) ?? `` }]);
    }
    return [...byFamily].map(([name, rows]) => ({ name, rows }));
});

// The one window whose own Mac chords (⌘W, ⌘⇧T, ⌘⇧]) the browser keeps; installed, Intentic gets them.
const appNote = computed(() => isMac && !appWindow && installOffered.value);
const appKeys = { close: formatChord(`Mod+W`, true), reopen: formatChord(`Mod+Shift+T`, true), next: formatChord(`Mod+Shift+]`, true) };

const openSettings = (): void => {
    open.value = false;
    void router.push(`/settings/keybindings`);
};
</script>

<template>
    <Modal v-model:open="open" size="lg" position="top" :header="t(`shell.useShellCommands.keyboardShortcuts`)">
        <div class="flex flex-col gap-4">
            <FilterBar v-model="query" :placeholder="t(`settings.settingsKeybindings.filterCommands`)" />
            <RowNote v-if="appNote" icon="info-circle">
                <span class="flex flex-wrap items-center justify-between gap-2">
                    <span>{{ t(`settings.settingsKeybindings.appWindowNote`, appKeys) }}</span>
                    <Button size="small" tier="boring" class="shrink-0" @click="void installApp()">{{
                        t(`settings.settingsKeybindings.installApp`)
                    }}</Button>
                </span>
            </RowNote>
            <RowGroup v-for="family in families" :key="family.name" :label="family.name || t(`shell.shortcutSheet.general`)">
                <Row v-for="row in family.rows" :key="row.command" :title="row.title">
                    <template #meta>
                        <kbd class="rounded border border-line bg-overlay px-1.5 py-0.5 font-mono text-muted">{{ row.keys }}</kbd>
                    </template>
                </Row>
            </RowGroup>
            <RowNote v-if="families.length === 0" variant="empty">{{ t(`settings.settingsKeybindings.noCommandsMatch`, { query }) }}</RowNote>
            <div class="flex justify-end">
                <Button size="small" tier="boring" @click="openSettings">{{ t(`shell.shortcutSheet.change`) }}</Button>
            </div>
        </div>
    </Modal>
</template>
