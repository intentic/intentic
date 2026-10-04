import type { DocsState, Engine, ForceSaveRequest, OpenRequest, OpenResult } from "./contract.js";
import { host } from "./host.js";

// The viewer's calls into its own backend, by paths relative to its namespace: the host adds `/x/<install id>`, which
// is `publisher.name` only for a baked extension, so a spelled prefix breaks the day this ships as a git install.

const json = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

// An editor URL when the engine is ready, else the state that stands in the way (a 409, not a failure).
export const openDocument = async (request: OpenRequest): Promise<OpenResult> => {
    const response = await host().backend.request(`open`, json(request));
    if (response.status === 409) {
        return { status: (await response.json()) as DocsState };
    }
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return (await response.json()) as OpenResult;
};

// The owner's one explicit act: the browser engine's download, or the document server's pull and start. Returns as
// soon as it is under way.
export const startDocs = async (engine: Engine): Promise<DocsState> => {
    const response = await host().backend.request(`start`, json({ engine }));
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return (await response.json()) as DocsState;
};

// Writes what a document server session's editor holds to the workspace now, for an editor the viewer keeps alive out
// of sight. A browser-engine editor is told by message instead (EditorSlot).
export const forceSaveDocument = async (request: ForceSaveRequest): Promise<void> => {
    const response = await host().backend.request(`forcesave`, json(request));
    if (!response.ok) {
        throw new Error(await response.text());
    }
};

// The document as it was before the first save a local window made to it, which that window's backend keeps (the
// desktop app's files sidecar). `keptAt` is when, in epoch milliseconds, where the backend's answer said so readably.
export interface KeptOriginal {
    readonly keptAt: number | undefined;
}

// What `/original` answers: whether an original is kept, and since when.
interface OriginalAnswer {
    readonly kept?: boolean;
    readonly keptAt?: string | number;
}

// A moment as a backend may write it, epoch milliseconds or a date string, as epoch milliseconds; undefined for
// anything that reads as neither.
const momentOf = (value: string | number | undefined): number | undefined => {
    if (value === undefined || value === ``) {
        return undefined;
    }
    const counted = Number(value);
    const at = Number.isNaN(counted) ? Date.parse(String(value)) : counted;
    return Number.isFinite(at) ? at : undefined;
};

// What `/original` answered: a kept original, or undefined for none. A backend without the route (a sandbox's) answers
// 404, which is the same answer: nothing to restore.
export const originalOf = async (path: string): Promise<KeptOriginal | undefined> => {
    const response = await host().backend.request(`original?${new URLSearchParams({ path }).toString()}`);
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(await response.text());
    }
    // SAFETY: the backend's own JSON answer; only a literal `kept: true` counts, and `keptAt` goes through momentOf,
    // which reads anything it can't make a moment of as none.
    const answer = (await response.json()) as OriginalAnswer | null;
    return answer?.kept === true ? { keptAt: momentOf(answer.keptAt) } : undefined;
};

// Puts the kept original back in place of the document. The editor holding the document is the caller's to reload.
export const restoreOriginal = async (path: string): Promise<void> => {
    const response = await host().backend.request(`restore-original`, json({ path }));
    if (!response.ok) {
        throw new Error(await response.text());
    }
};
