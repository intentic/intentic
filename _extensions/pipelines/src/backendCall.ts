import type { IntenticApi } from "@intentic/extension-api";
import type { CiFixParam, CiForgetParam, CiRunParam } from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";

// Use the daemon's installed manifest to pick the route. A host that predates the availability hint can still
// discover an absent backend from its 404 or 503 and fall back to the route its daemon's manifest grants.
const NO_BACKEND = new Set([404, 503]);

// A failed call the daemon answered carries the HTTP status; a call refused before it was sent (an undeclared route), or
// one that never got an answer, carries none.
const AnsweredSchema = z.object({ status: z.number() });

export type BackendCaller = Pick<IntenticApi, `backend` | `sandbox`>;

// A JSON body for a POST to either door.
export const posting = (body: CiRunParam | CiForgetParam | CiFixParam): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

// The way back (`legacy`): a route the daemon's contract still carries, through its typed client; or one it took off, by
// its path through `api.sandbox.json`.
// The installed manifest says there is no backend, so the old route is asked first. A host can have heard that of a daemon
// since rebuilt with the backend (2026-11-26: every Fix came back 404 from the `/ci/fix` the new daemon dropped), so the
// old route gone is the cue to ask the backend once; only an answer from a backend that is there outvotes the old route's.
const legacyFirst = async <T>(api: BackendCaller, path: string, legacy: () => Promise<T>, init?: RequestInit): Promise<T> => {
    try {
        return await legacy();
    } catch (legacyError) {
        if (AnsweredSchema.safeParse(legacyError).data?.status !== 404) {
            throw legacyError;
        }
        try {
            return await api.backend.json<T>(path, init);
        } catch (backendError) {
            const heard = AnsweredSchema.safeParse(backendError).data?.status;
            throw heard === undefined || NO_BACKEND.has(heard) ? legacyError : backendError;
        }
    }
};

// The backend first, and the old route only when no backend answered and the manifest never said one is there.
const backendFirst = async <T>(api: BackendCaller, path: string, legacy: () => Promise<T>, init?: RequestInit): Promise<T> => {
    try {
        return await api.backend.json<T>(path, init);
    } catch (backendError: unknown) {
        if (api.backend.available === true || !NO_BACKEND.has(AnsweredSchema.safeParse(backendError).data?.status ?? 0)) {
            throw backendError;
        }
        try {
            return await legacy();
        } catch (legacyError) {
            // The old route answering for itself (a refusal, a missing run) is the daemon's word; one refused before it was
            // sent means this daemon has no such route, and the backend's answer stands.
            throw AnsweredSchema.safeParse(legacyError).success ? legacyError : backendError;
        }
    }
};

export const backendCall = async <T>(api: BackendCaller, path: string, legacy: () => Promise<T>, init?: RequestInit): Promise<T> =>
    api.backend.available === false ? await legacyFirst(api, path, legacy, init) : await backendFirst(api, path, legacy, init);
