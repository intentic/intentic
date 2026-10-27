import type { MemberRefusal } from "@intentic/sandbox-contract/protocol/member-reach";

// THE ACCESS CHECK THE FETCH LAYER ASKS BEFORE SENDING (sandboxAuthFetch.ts), kept free of every other module so the
// fetch layer can ask it without importing what answers it: the answer needs the person's access (useAccess.ts), which
// is itself read over the fetch layer. `useAccess` installs the forecaster when it loads; until then nothing is
// forecast and every request goes out as before.

/** Why the active sandbox would refuse this request from the signed-in person, or undefined when it would not, or nobody knows yet. */
export type Forecast = (sandboxId: string | undefined, method: string, path: string, target: string | undefined) => MemberRefusal | undefined;

// allow(module-state): the one forecaster for the page, installed once by useAccess.ts
let forecaster: Forecast | undefined;
// allow(module-state): what to do when the daemon refused something the forecast let through: the access it read is stale
let unforeseen: (() => void) | undefined;

/** Installs the check, and what to do when the daemon refuses a request the check let through. */
export const forecastWith = (next: Forecast, refusedUnforeseen: () => void): void => {
    forecaster = next;
    unforeseen = refusedUnforeseen;
};

export const forecastRefusal: Forecast = (sandboxId, method, path, target) => forecaster?.(sandboxId, method, path, target);

/** The daemon refused on access grounds a request the forecast let through. */
export const refusedUnforeseen = (): void => unforeseen?.();
