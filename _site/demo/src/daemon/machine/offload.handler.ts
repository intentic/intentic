import type { Doors } from "../doors";

// The kinds a fresh sandbox sorts heavy work into, so "Where heavy work runs" draws its rows; nothing ever ran on a
// runner in a recording, and sending a command to one needs a machine this demo does not have.
export const offloadDoors = {
    kinds: () => ({
        kinds: [
            { id: `repo-verify`, pattern: `\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b` },
            { id: `typechecker`, pattern: `(?<![-.])\\b(tsc|tsgo|vue-tsc)\\b(?![-.])` },
            { id: `package-script`, pattern: `\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\b(test|typecheck|verify|check|build)\\b` },
        ],
    }),
    runs: () => ({ runs: [] }),
    // Where a new chat should start: the demo pairs no runner, so this machine is the only one, and it has room.
    placement: () => ({
        mode: `suggest` as const,
        here: {
            standing: `calm` as const,
            strain: [],
            cpus: 8,
            load: 0.18,
            memoryFreeMb: 11_264,
            memoryLimitMb: 16_384,
            agents: 1,
            slots: 6,
            headroom: 0.83,
        },
        machines: [],
    }),
} satisfies Doors<`offload`>;
