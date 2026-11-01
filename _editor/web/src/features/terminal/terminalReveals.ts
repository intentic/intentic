import { z } from "zod";
import { storedJson, storeJson } from "../../app/storage/browserStorage";

// Work terminals (agent/job) a surface was asked to show, remembered per sandbox under `key`: minimizing tears the
// panel down, and a run still building or followed on a computer must be back on the strip when it reopens (or the page
// reloads). Storage that is off holds them for this instance only.

const StoredNamesSchema = z.array(z.unknown()).transform((names) => names.filter((name): name is string => typeof name === `string`));

export interface TerminalReveals {
    readonly has: (name: string) => boolean;
    readonly add: (name: string) => void;
    // Whether the name was revealed.
    readonly delete: (name: string) => boolean;
    // Re-reads the sandbox's own after a switch.
    readonly reload: () => void;
    // Lets go of reveals whose session is gone (it ended while no panel was open to hear it), sparing `waitingFor`: the
    // one an open request has not seen listed yet.
    readonly forgetGone: (listed: readonly { readonly name: string }[], waitingFor: string | undefined) => void;
}

export const createTerminalReveals = (key: () => string): TerminalReveals => {
    const read = (): Set<string> => new Set(storedJson(key(), StoredNamesSchema) ?? []);
    let names = read();
    const persist = (): void => storeJson(key(), [...names]);
    const drop = (name: string): boolean => {
        const had = names.delete(name);
        if (had) {
            persist();
        }
        return had;
    };
    return {
        has: (name) => names.has(name),
        add: (name) => {
            names.add(name);
            persist();
        },
        delete: drop,
        reload: () => {
            names = read();
        },
        forgetGone: (listed, waitingFor) => {
            const live = new Set(listed.map((tab) => tab.name));
            [...names].filter((name) => !live.has(name) && name !== waitingFor).forEach(drop);
        },
    };
};
