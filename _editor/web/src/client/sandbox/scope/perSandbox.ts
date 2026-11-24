// STATE KEPT PER SANDBOX, BY ID, FOR AS LONG AS THAT SANDBOX IS THIS ACCOUNT'S AND THE SAME WORKSPACE. `sandboxRef`
// (@intentic/extension-api) holds one value for the active sandbox and refills it on every switch; this holds one per id
// side by side, so a reader of another sandbox (a Home tile, the rail's door to Home) keeps what it read across a switch.
// An id's entry goes when its workspace is replaced under that id (systemEventRouting.ts `dropSandboxLocalState`), when
// the sandbox leaves this account (useSandbox's `remove`), and every entry goes with the account (accountTeardown.ts).

interface Dropping {
    readonly drop: (id: string) => void;
    readonly clear: () => void;
}

const registered: Dropping[] = [];

/** Enrols state that is not a `perSandbox` (a reactive map of its own) in the same drops. */
export const onSandboxDropped = (dropping: Dropping): void => {
    registered.push(dropping);
};

interface PerSandbox<T> {
    // The id's value, made from `initial(id)` the first time it is asked for.
    readonly of: (id: string) => T;
    // Forgets the id's value, handing it to `dispose` first; the next `of(id)` makes a fresh one.
    readonly drop: (id: string) => void;
}

export const perSandbox = <T>(initial: (id: string) => T, dispose?: (value: T, id: string) => void): PerSandbox<T> => {
    // Boxed, so a value that is itself undefined is told apart from one never made.
    const values = new Map<string, { readonly value: T }>();
    const drop = (id: string): void => {
        const held = values.get(id);
        if (held !== undefined) {
            values.delete(id);
            dispose?.(held.value, id);
        }
    };
    onSandboxDropped({
        drop,
        clear: () => {
            // A Map's iteration survives deleting the entry it stands on.
            for (const id of values.keys()) {
                drop(id);
            }
        },
    });
    return {
        of: (id) => {
            const held = values.get(id) ?? { value: initial(id) };
            values.set(id, held);
            return held.value;
        },
        drop,
    };
};

/** Forgets everything kept for sandbox `id`: its workspace was replaced, or it left this account. */
export const dropSandboxScope = (id: string): void => {
    for (const entry of registered) {
        entry.drop(id);
    }
};

/** Forgets everything kept for every sandbox: the account left this browser. */
export const dropEverySandboxScope = (): void => {
    for (const entry of registered) {
        entry.clear();
    }
};
