import type { IntenticApi } from "@intentic/extension-api";
import { z } from "zod";

// One read from this extension's own backend, with the way back to an older daemon.
//
// The browser half is compiled into the editor, which ships with each release and drives sandboxes still on an older
// image. A daemon whose image predates the backend has no `/x/<id>/` namespace for this extension (its host answers 404,
// or 503 when it runs no backend at all), but still serves the same read at its own route, which that daemon's copy of
// this manifest grants. So a read the backend did not answer is asked there once. Against a daemon that has the backend,
// its own manifest no longer grants the old route, the host refuses the call before anything is sent, and the backend's
// answer is the one said. Not yet tagged as a daemon fallback (docs/architecture/conventions.md, "Version skew"): the
// first release carrying the backend is not cut yet, and the tag names it.

// The statuses with which a daemon without this backend answers its namespace.
const NO_BACKEND = new Set([404, 503]);

// A failed call the daemon answered carries the HTTP status; a call refused before it was sent (an undeclared route), or
// one that never got an answer, carries none.
const AnsweredSchema = z.object({ status: z.number() });

export type BackendReader = Pick<IntenticApi, `backend` | `sandbox`>;

export const backendRead = async <T>(api: BackendReader, path: string, legacyPath: string): Promise<T> => {
    try {
        return await api.backend.json<T>(path);
    } catch (backendError: unknown) {
        if (!NO_BACKEND.has(AnsweredSchema.safeParse(backendError).data?.status ?? 0)) {
            throw backendError;
        }
        try {
            return await api.sandbox.json<T>(legacyPath);
        } catch (legacyError) {
            // The old route answering for itself (a refusal, a missing package) is the daemon's word; one refused before
            // it was sent means this daemon has no such route, and the backend's answer stands.
            throw AnsweredSchema.safeParse(legacyError).success ? legacyError : backendError;
        }
    }
};
