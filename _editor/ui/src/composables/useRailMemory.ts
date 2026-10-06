import { computed, type Ref, watch, type WritableComputedRef } from "vue";

// Remembers a narrowing rail's last choice in localStorage and puts it back whenever the view stands on its bare
// address: a rail tile always links there, so without this every return (and every click on the tile of the view
// already open) lands on "all". The choice still lives in the URL; this only fills the URL when it names nothing.
//
// Bind the picker to the RETURNED ref, not to `choice`: a pick made through it is the only thing that may remember
// "all", which is how a deliberately widened scope stays wide instead of the tile pulling last week's repo back.
// A URL that names a choice (a pick, a shared link, Back) is remembered too; the URL going bare by itself is not.

const keyOf = (id: string): string => `intentic.rail.${id}`;

// `` and undefined both mean unnarrowed (a Picker has no undefined to offer).
const isEmpty = (value: string | undefined): value is `` | undefined => value === undefined || value === ``;

const read = (id: string): string | undefined => {
    try {
        return localStorage.getItem(keyOf(id)) ?? undefined;
    } catch {
        // Storage may be unavailable (private mode); the rail opens on its default.
        return undefined;
    }
};

const write = (id: string, value: string): void => {
    try {
        localStorage.setItem(keyOf(id), value);
    } catch {
        // Storage may be unavailable; the choice still holds for this visit.
    }
};

/**
 * Remember a narrowing rail's choice and restore it whenever its view stands without one.
 * `options` arrives reactively after mount; a restore waits for it, and never selects a value it does not offer.
 * Returns the ref the rail's controls should write through.
 */
export function useRailMemory<T extends string | undefined>(id: string, choice: Ref<T>, options: () => readonly string[]): WritableComputedRef<T> {
    watch(
        choice,
        (value) => {
            if (!isEmpty(value)) {
                write(id, value);
            }
        },
        { immediate: true },
    );

    watch(
        [() => isEmpty(choice.value), options],
        ([empty, values]) => {
            const held = read(id);
            if (empty && !isEmpty(held) && values.includes(held)) {
                choice.value = held as T;
            }
        },
        { immediate: true },
    );

    return computed<T>({
        get: () => choice.value,
        set: (value) => {
            write(id, value ?? ``);
            choice.value = value;
        },
    });
}
