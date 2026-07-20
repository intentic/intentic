<script setup lang="ts">
import { Card } from "@intentic-app/ui";
import { computed, onUnmounted, ref } from "vue";
import { commands } from "../../composables/commands/useCommands";
import { chordFromEvent, formatChord, isApplePlatform } from "../../composables/commands/keybindings";
import { effectiveKeybinding, keymapOverrides, useKeymap } from "../../composables/commands/useKeymap";

/* Keybindings: the user-facing face of the keymap (useKeymap). Lists every registered command — builtins and
 * extension-contributed alike, since they share one registry — with its EFFECTIVE chord, and lets the user record a
 * new shortcut, revert to the command's default, or unbind it. A remap persists to the keymap store and takes
 * effect live everywhere (dispatcher + palette). Recording captures one keystroke in the capture phase with
 * stopPropagation, so the shell's global dispatcher never fires the old shortcut mid-capture. */

const isMac = isApplePlatform();
const { setKeybinding, unbindKeybinding, resetKeybinding, resetKeymap } = useKeymap();

const query = ref(``);
// The command id currently capturing a keystroke, or undefined when not recording.
const recording = ref<string | undefined>(undefined);

interface Row {
    readonly command: string;
    readonly title: string;
    readonly owner: string;
    readonly chord: string | undefined;
    readonly overridden: boolean;
    readonly hasDefault: boolean;
}

const rows = computed<readonly Row[]>(() => {
    const q = query.value.trim().toLowerCase();
    return commands.value
        .map(
            (entry): Row => ({
                command: entry.command,
                title: entry.title,
                owner: entry.owner,
                chord: effectiveKeybinding(entry.command, entry.keybinding),
                overridden: keymapOverrides.value[entry.command] !== undefined,
                hasDefault: entry.keybinding !== undefined,
            }),
        )
        .filter((row) => q.length === 0 || row.title.toLowerCase().includes(q) || row.command.toLowerCase().includes(q))
        .sort((a, b) => a.title.localeCompare(b.title));
});

// Any override at all → the "Reset all" affordance is meaningful.
const hasAnyOverride = computed(() => Object.keys(keymapOverrides.value).length > 0);

// chord → command ids sharing it, so a row can warn when its shortcut collides with another's (the shell resolves
// a live conflict by first-registered-wins, but the user should see it).
const chordOwners = computed<Record<string, readonly string[]>>(() => {
    const byChord: Record<string, string[]> = {};
    for (const entry of commands.value) {
        const chord = effectiveKeybinding(entry.command, entry.keybinding);
        if (chord !== undefined) {
            (byChord[chord] ??= []).push(entry.command);
        }
    }
    return byChord;
});
const conflicting = (chord: string | undefined): boolean => chord !== undefined && (chordOwners.value[chord]?.length ?? 0) > 1;

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
    // Capture phase so this handler beats the shell dispatcher's window listener and stopPropagation halts it.
    window.addEventListener(`keydown`, onCapture, true);
};

const stopRecording = (): void => {
    recording.value = undefined;
    window.removeEventListener(`keydown`, onCapture, true);
};

onUnmounted(stopRecording);
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <Card class="flex items-center justify-between gap-3">
            <div class="min-w-0">
                <h2 class="font-semibold leading-tight">Keyboard shortcuts</h2>
                <p class="text-xs text-muted">Record a new shortcut for any command, or reset it to the default. Shortcuts are per-browser.</p>
            </div>
            <button
                v-if="hasAnyOverride"
                type="button"
                class="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-content"
                @click="resetKeymap()"
            >
                Reset all
            </button>
        </Card>

        <div class="relative">
            <Icon class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle" name="search" aria-hidden="true" />
            <input
                v-model="query"
                type="text"
                placeholder="Filter commands…"
                class="w-full min-w-0 rounded-md border border-line bg-canvas py-2 pl-9 pr-3 text-sm text-content placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
        </div>

        <Card class="!p-0">
            <div v-for="row in rows" :key="row.command" class="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                        <span class="truncate text-sm text-content">{{ row.title }}</span>
                        <span v-if="row.owner !== 'builtin'" class="shrink-0 rounded bg-overlay px-1 text-2xs text-subtle">ext</span>
                    </div>
                    <span class="block truncate text-2xs text-subtle">{{ row.command }}</span>
                </div>

                <div class="flex w-40 shrink-0 items-center justify-end gap-1.5">
                    <span v-if="recording === row.command" class="text-2xs italic text-primary-500">Press keys… (Esc)</span>
                    <template v-else>
                        <span
                            v-if="conflicting(row.chord)"
                            v-tooltip.top="'Another command uses this shortcut'"
                            class="text-warning"
                        >
                            <Icon name="exclamation-triangle" class="text-[0.7rem]" />
                        </span>
                        <kbd
                            v-if="row.chord"
                            class="rounded border border-line bg-overlay px-1.5 py-0.5 font-mono text-2xs text-muted"
                            :class="{ 'border-warning/50': conflicting(row.chord) }"
                            >{{ formatChord(row.chord, isMac) }}</kbd
                        >
                        <span v-else class="text-2xs text-subtle">Unbound</span>
                    </template>
                </div>

                <div class="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        class="rounded p-1.5 text-muted transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.top="recording === row.command ? 'Cancel' : 'Record shortcut'"
                        :aria-label="recording === row.command ? 'Cancel recording' : `Record shortcut for ${row.title}`"
                        @click="recording === row.command ? stopRecording() : startRecording(row.command)"
                    >
                        <Icon :name="recording === row.command ? 'times' : 'pencil'" class="text-sm" />
                    </button>
                    <button
                        v-if="row.chord && recording !== row.command"
                        type="button"
                        class="rounded p-1.5 text-muted transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.top="'Unbind'"
                        :aria-label="`Unbind ${row.title}`"
                        @click="unbindKeybinding(row.command)"
                    >
                        <Icon name="trash" class="text-sm" />
                    </button>
                    <button
                        v-if="row.overridden && recording !== row.command"
                        type="button"
                        class="rounded p-1.5 text-muted transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.top="'Reset to default'"
                        :aria-label="`Reset ${row.title} to default`"
                        @click="resetKeybinding(row.command)"
                    >
                        <Icon name="undo" class="text-sm" />
                    </button>
                </div>
            </div>

            <p v-if="rows.length === 0" class="px-3 py-6 text-center text-xs text-subtle">No commands match “{{ query }}”.</p>
        </Card>
    </div>
</template>
