import type { IntenticApi } from "@intentic/extension-api";

/* The activated host handle. */
let current: IntenticApi | undefined;

export const bindHost = (api: IntenticApi): void => {
    current = api;
};

export const host = (): IntenticApi => {
    if (current === undefined) {
        throw new Error(`intentic.example: host() called before activate()`);
    }
    return current;
};
