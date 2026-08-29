<script setup lang="ts">
import { FilterBar, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import { commands } from "../../composables/commands/useCommands";
import { chordFromEvent, formatChord, isApplePlatform } from "../../composables/commands/keybindings";
import { effectiveKeybinding, keymapOverrides, useKeymap } from "../../composables/commands/useKeymap";

/* Keybindings: the user-facing face of the keymap (useKeymap). Lists every registered command (builtins and
 * extension-contributed alike, since they share one registry) with its EFFECTIVE chord, and lets the user record a
 * new shortcut, revert to the command's default, or unbind it. A remap persists to the keymap store and takes
 * effect live everywhere (dispatcher + palette). Recording captures one keystroke in the capture phase with
 * stopPropagation, so the shell's global dispatcher never fires the old shortcut mid-capture. */

const isMac = isApplePlatform();
const { setKeybinding, unbindKeybinding, resetKeybinding, resetKeymap } = useKeymap();

const query = ref(``);
// The command id currently capturing a keystroke, or undefined when not recording.
const recording = ref<string | undefined>(undefined);

interface CommandRow {
    readonly command: string;
    readonly title: string;
    readonly owner: string;
    readonly chord: string | undefined;
    readonly overridden: boolean;
    readonly hasDefault: boolean;
}

const rows = computed<readonly CommandRow[]>(() => {
    const q = query.value.trim().toLowerCase();
    return commands.value
        .map((entry): CommandRow => ({
            command: entry.command,
            title: entry.title,
            owner: entry.owner,
            chord: effectiveKeybinding(entry.command, entry.keybinding),
            overridden: keymapOverrides.value[entry.command] !== undefined,
            hasDefault: entry.keybinding !== undefined,
        }))
        .filter((row) => q.length === 0 || row.title.toLowerCase().includes(q) || row.command.toLowerCase().includes(q))
        .toSorted((a, b) => a.title.localeCompare(b.title));
});

// Any override at all → the "Reset all" affordance is meaningful.
const hasAnyOverride = computed(() => Object.keys(keymapOverrides.value).length > 0);

// chord → command ids sharing it, so a row can warn when its shortcut collides with another's (the shell resolves
// a live conflict by first-registered-wins, but the user should see it). Commands with a `when` gate are left out
// of the count: they only claim the chord in their own context (F2 renames the focused terminal OR the focused
// chat, never both), so counting them would cry conflict over bindings that can't actually collide.
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

// Recording is a two-way pair: the capture handler ends it, and ending it detaches the handler, so the
// listener rides in a variable both can name and neither has to be declared before the other.
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
            <button
                type="button"
                class="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-content"
                @click="resetKeymap()"
            >
                Reset all
            </button>
        </div>

        <FilterBar v-model="query" placeholder="Filter commands…" :count="rows.length" />

        <!-- A record list — a hundred-odd commands, read by scanning — so the group takes the compact tier and
             its rows and its "nothing matched" line read it from there. -->
        <RowGroup>
            <Row v-for="row in rows" :key="row.command" :title="row.title" :description="row.command">
                <template #title>
                    <span class="flex items-center gap-2">
                        <span class="truncate">{{ row.title }}</span>
                        <span v-if="row.owner !== 'builtin'" class="shrink-0 rounded bg-overlay px-1 text-2xs font-normal text-subtle">ext</span>
                    </span>
                </template>

                <!-- The chord is a FACT about the command, so it rides #meta and lines up down the column; the
                     three buttons that change it are actions and ride #control. The fixed width is what keeps
                     every kbd in one vertical line rather than ragged against its row's title length. -->
                <template #meta>
                    <span class="flex w-40 items-center justify-end gap-1.5">
                        <span v-if="recording === row.command" class="italic text-primary-500">Press keys… (Esc)</span>
                        <template v-else>
                            <span v-if="conflicting(row.chord)" v-tooltip.top="'Another command uses this shortcut'" class="text-warning">
                                <Icon name="exclamation-triangle" />
                            </span>
                            <kbd
                                v-if="row.chord"
                                class="rounded border border-line bg-overlay px-1.5 py-0.5 font-mono text-muted"
                                :class="{ 'border-warning/50': conflicting(row.chord) }"
                                >{{ formatChord(row.chord, isMac) }}</kbd
                            >
                            <span v-else>Unbound</span>
                        </template>
                    </span>
                </template>

                <template #control>
                    <button
                        type="button"
                        :class="ui.iconButton()"
                        v-tooltip.top="recording === row.command ? 'Cancel' : 'Record shortcut'"
                        :aria-label="recording === row.command ? 'Cancel recording' : `Record shortcut for ${row.title}`"
                        @click="recording === row.command ? stopRecording() : startRecording(row.command)"
                    >
                        <Icon :name="recording === row.command ? 'times' : 'pencil'" />
                    </button>
                    <button
                        v-if="row.chord && recording !== row.command"
                        type="button"
                        :class="ui.iconButton()"
                        v-tooltip.top="'Unbind'"
                        :aria-label="`Unbind ${row.title}`"
                        @click="unbindKeybinding(row.command)"
                    >
                        <Icon name="trash" />
                    </button>
                    <button
                        v-if="row.overridden && recording !== row.command"
                        type="button"
                        :class="ui.iconButton()"
                        v-tooltip.top="'Reset to default'"
                        :aria-label="`Reset ${row.title} to default`"
                        @click="resetKeybinding(row.command)"
                    >
                        <Icon name="undo" />
                    </button>
                </template>
            </Row>

            <RowNote v-if="rows.length === 0" variant="empty">No commands match "{{ query }}".</RowNote>
        </RowGroup>
    </div>
</template>
