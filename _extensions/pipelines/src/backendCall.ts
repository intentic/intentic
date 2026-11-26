import type { IntenticApi } from "@intentic/extension-api";
import type { CiFixParam, CiForgetParam, CiRunParam } from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";

// One call to this extension's own backend (src/server/board.ts), with the way back to an older daemon.
//
// The browser half is compiled into the editor, which ships with each release and drives sandboxes still on an older
// image. A daemon whose image predates the backend (before 2026-11-26, when main's fix agent and the board's procedures
// moved here) has no `/x/<id>/` namespace for this extension (its host answers 404, or 503 when it runs no backend at all),
// but still answers the same call at its own route (backendRoutes.ts LEGACY), which that daemon's copy of this manifest
// grants. So a call the backend did not answer is made there once. Against a daemon that has the backend, its own manifest
// no longer grants the old route, the host refuses the call before anything is sent, and the backend's answer is the one
// said. The repo-apps extension's backendRead.ts is the pattern. Not yet tagged as a daemon fallback
// (docs/architecture/conventions.md, "Version skew"): the first release carrying the backend is not cut yet, and the tag
// names it.

// The statuses with which a daemon without this backend answers its namespace.
const NO_BACKEND = new Set([404, 503]);

// A failed call the daemon answered carries the HTTP status; a call refused before it was sent (an undeclared route), or
// one that never got an answer, carries none.
const AnsweredSchema = z.object({ status: z.number() });

export type BackendCaller = Pick<IntenticApi, `backend` | `sandbox`>;

// A JSON body for a POST to either door.
export const posting = (body: CiRunParam | CiForgetParam | CiFixParam): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

// The way back (`legacy`): a route the daemon's contract still carries, through its typed client; or one it took off, by
// its path through `api.sandbox.json`.
export const backendCall = async <T>(api: BackendCaller, path: string, legacy: () => Promise<T>, init?: RequestInit): Promise<T> => {
    try {
        return await api.backend.json<T>(path, init);
    } catch (backendError: unknown) {
        if (!NO_BACKEND.has(AnsweredSchema.safeParse(backendError).data?.status ?? 0)) {
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
