<script setup lang="ts">
import { Button, FilterBar, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import { commandLabel, commands } from "../../shell/commands/useCommands";
import { rankCommands } from "../../shell/commands/commandSearch";
import { chordFromEvent, formatChord, isApplePlatform } from "../../shell/commands/keybindings";
import { effectiveKeybinding, keymapOverrides, useKeymap } from "../../shell/commands/useKeymap";
import { useT } from "@intentic/ui/i18n";

// Lists every command (builtins and extensions share one registry) with its effective chord; lets the user record,
// reset, or unbind a shortcut, live everywhere via the keymap store. Recording captures one keystroke in the capture
// phase, so the shell's dispatcher never fires the old shortcut mid-capture.

const t = useT();

const isMac = isApplePlatform();
const { setKeybinding, unbindKeybinding, resetKeybinding, resetKeymap } = useKeymap();

const query = ref(``);
// The command id currently capturing a keystroke, or undefined when not recording.
const recording = ref<string | undefined>(undefined);

interface CommandRow {
    readonly command: string;
    readonly title: string;
    readonly category: string | undefined;
    /** "Category: Title", for the places that need the command's whole name in one string (tooltips, aria). */
    readonly label: string;
    readonly owner: string;
    readonly chord: string | undefined;
    readonly overridden: boolean;
    readonly hasDefault: boolean;
}

// Filtered and ordered by the palette's own matcher, so a word that finds a command there finds it here; families end
// up in one run, since ordering falls back to the "Category: Title" the palette shows.
const rows = computed<readonly CommandRow[]>(() =>
    rankCommands(commands.value, query.value).map((entry): CommandRow => ({
        command: entry.command,
        title: entry.title,
        category: entry.category,
        label: commandLabel(entry),
        owner: entry.owner,
        chord: effectiveKeybinding(entry.command, entry.keybinding),
        overridden: keymapOverrides.value[entry.command] !== undefined,
        hasDefault: entry.keybinding !== undefined,
    })),
);

// Any override at all → the "Reset all" affordance is meaningful.
const hasAnyOverride = computed(() => Object.keys(keymapOverrides.value).length > 0);

// Chord → commands sharing it, for collision warnings; a `when` gate excludes a command since it can't collide.
const chordOwners = computed<Record<string, readonly string[]>>(() => {
    const byChord: Record<string, string[]> = {};
    for (const entry of commands.value) {
        if (entry.when !== undefined) {
            continue;
        }
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        if (chord !== undefined) {
            (byChord[chord] ??= []).push(entry.command);
        }
    }
    return byChord;
});
const conflicting = (chord: string | undefined): boolean => chord !== undefined && (chordOwners.value[chord]?.length ?? 0) > 1;

// Shared so the capture handler and stopRecording can each reference and clear the same listener.
let capture: ((event: KeyboardEvent) => void) | undefined;

const stopRecording = (): void => {
    recording.value = undefined;
    if (capture !== undefined) {
        window.removeEventListener(`keydown`, capture, true);
        capture = undefined;
    }
};

const onCapture = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === `Escape`) {
        stopRecording();
        return;
    }
    const chord = chordFromEvent(event, isMac);
    // A lone modifier / invalid keystroke: keep listening for the real chord.
    if (chord === undefined) {
        return;
    }
    const command = recording.value;
    if (command !== undefined) {
        setKeybinding(command, chord);
    }
    stopRecording();
};

const startRecording = (command: string): void => {
    // Swap targets cleanly if another row was already capturing.
    stopRecording();
    recording.value = command;
    capture = onCapture;
    // Capture phase so this handler beats the shell dispatcher's window listener and stopPropagation halts it.
    window.addEventListener(`keydown`, capture, true);
};

onUnmounted(stopRecording);
</script>

<template>
    <div class="flex flex-col gap-3">
        <div v-if="hasAnyOverride" class="flex justify-end">
            <Button size="small" severity="secondary" class="shrink-0" @click="resetKeymap()">
                {{ t(`settings.settingsKeybindings.resetAll`) }}
            </Button>
        </div>

        <FilterBar v-model="query" :placeholder="t(`settings.settingsKeybindings.filterCommands`)" :count="rows.length" />

        <!-- Compact tier: a long list of commands read by scanning. -->
        <RowGroup>
            <Row v-for="row in rows" :key="row.command" :title="row.label" :description="row.command">
                <template #title>
                    <span class="flex items-center gap-2">
                        <span class="truncate"
                            ><span v-if="row.category" class="text-muted">{{ row.category }}: </span>{{ row.title }}</span
                        >
                        <span v-if="row.owner !== 'builtin'" class="shrink-0 rounded bg-overlay px-1 text-2xs font-normal text-subtle">{{
                            t(`settings.settingsKeybindings.ext`)
                        }}</span>
                    </span>
                </template>

                <!-- Chord is a fact (#meta, right-aligned); the buttons that change it are actions (#control), at a fixed width. -->
                <template #meta>
                    <span class="flex w-40 items-center justify-end gap-1.5">
                        <span v-if="recording === row.command" class="italic text-primary-500">{{
                            t(`settings.settingsKeybindings.pressKeysEsc`)
                        }}</span>
                        <template v-else>
                            <span
                                v-if="conflicting(row.chord)"
                                v-tooltip.top="t(`settings.settingsKeybindings.anotherCommandUsesShortcut`)"
                                class="text-warning"
                            >
                                <Icon name="exclamation-triangle" />
                            </span>
                            <kbd
                                v-if="row.chord"
                                class="rounded border border-line bg-overlay px-1.5 py-0.5 font-mono text-muted"
                                :class="{ 'border-warning/50': conflicting(row.chord) }"
                                >{{ formatChord(row.chord, isMac) }}</kbd
                            >
                            <span v-else>{{ t(`settings.settingsKeybindings.unbound`) }}</span>
                        </template>
                    </span>
                </template>

                <template #control>
                    <button
                        type="button"
                        :class="ui.iconButton()"
                        v-tooltip.top="recording === row.command ? t(`ui.action.cancel`) : t(`settings.settingsKeybindings.recordShortcut`)"
                        :aria-label="
                            recording === row.command
                                ? t(`settings.settingsKeybindings.cancelRecording`)
                                : t(`settings.settingsKeybindings.recordShortcut2`, { label: row.label })
                        "
                        @click="recording === row.command ? stopRecording() : startRecording(row.command)"
                    >
                        <Icon :name="recording === row.command ? 'times' : 'pencil'" />
                    </button>
                    <button
                        v-if="row.chord && recording !== row.command"
                        type="button"
                        :class="ui.iconButton()"
                        v-tooltip.top="t(`settings.settingsKeybindings.unbind`)"
                        :aria-label="t(`settings.settingsKeybindings.unbind2`, { label: row.label })"
                        @click="unbindKeybinding(row.command)"
                    >
                        <Icon name="trash" />
                    </button>
                    <button
                        v-if="row.overridden && recording !== row.command"
                        type="button"
                        :class="ui.iconButton()"
                        v-tooltip.top="t(`settings.settingsKeybindings.resetToDefault`)"
                        :aria-label="t(`settings.settingsKeybindings.resetToDefault2`, { label: row.label })"
                        @click="resetKeybinding(row.command)"
                    >
                        <Icon name="undo" />
                    </button>
                </template>
            </Row>

            <RowNote v-if="rows.length === 0" variant="empty">{{ t(`settings.settingsKeybindings.noCommandsMatch`, { query }) }}</RowNote>
        </RowGroup>
    </div>
</template>
