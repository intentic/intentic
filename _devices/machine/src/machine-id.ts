import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { MachineIdSchema } from "@intentic/sandbox-contract";
import { baseDir } from "./config.js";

// WHICH COMPUTER THIS IS, minted once and kept: the id a sandbox joins this machine's enrollments, sync enrollment and
// device rows on (the contract's MachineIdSchema says why never a hostname). Created at install (completeSetup) and by
// whichever command first needs it on a machine installed before it existed. A WSL distro's agent is started by its
// Windows side, which hands it the PC's own id: a distro is an environment of that computer, not a second computer.

export const machineIdPath = join(baseDir, "machine-id");

// How the Windows side hands its id to the agents it starts in each distro (carried across by WSLENV).
export const MACHINE_ID_ENV = "INTENTIC_MACHINE_ID";

const valid = (value: string | undefined): string | undefined => MachineIdSchema.safeParse(value?.trim()).data;

// No file yet is no id; an unreadable one throws rather than being minted over.
const read = (path: string): string | undefined => {
    try {
        return valid(readFileSync(path, "utf8"));
    } catch (error) {
        return undefinedIfMissing(error);
    }
};

// Temp-then-rename, so a reader never sees half an id.
const write = (path: string, id: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    const part = `${path}.part`;
    writeFileSync(part, `${id}\n`, { mode: 0o644 });
    renameSync(part, path);
};

// This machine's id. Synchronous on purpose: the Windows side spawns its distros' agents from a synchronous seam, and
// a file this small is cheaper than the promise around it. A handed-down id wins over a stored one and replaces it, so a
// distro that ran standalone before its Windows side supervised it joins the PC from then on.
export const machineId = (env: NodeJS.ProcessEnv = process.env, path: string = machineIdPath): string => {
    const handed = valid(env[MACHINE_ID_ENV]);
    const stored = read(path);
    if (handed !== undefined) {
        if (handed !== stored) {
            write(path, handed);
        }
        return handed;
    }
    if (stored !== undefined) {
        return stored;
    }
    const minted = `m-${randomUUID()}`;
    write(path, minted);
    return minted;
};
