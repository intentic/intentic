import { sandboxRef } from "@intentic/extension-api";

// Runs the panel is not opened for because they happen too often to be news (a push, runWatcher.ts's `quiet`): while
// one goes, the rail's terminal tile says so instead (useRuntimeChips.ts). One daemon's runs, so a switch drops them.

// What the tile's hover card says about one: a word and a name, built when read so it follows the language.
export interface QuietRunRow {
    readonly label: string;
    readonly value: string;
}

interface QuietRun {
    readonly id: number;
    readonly row: () => QuietRunRow;
}

const held = sandboxRef<readonly QuietRun[]>(() => []);
let nextId = 0;

// Says a run is going until the answer is called; calling it again, or after a sandbox switch, changes nothing.
export const holdQuietRun = (row: () => QuietRunRow): (() => void) => {
    const id = nextId++;
    held.value = [...held.value, { id, row }];
    return () => {
        held.value = held.value.filter((run) => run.id !== id);
    };
};

export const quietRunRows = (): readonly QuietRunRow[] => held.value.map((run) => run.row());
