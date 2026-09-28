import { NAMESPACE, type DocsState, type Engine, type ForceSaveRequest, type OpenRequest, type OpenResult } from "./contract.js";
import { host } from "./host.js";

// The viewer's calls into its own backend; the namespace needs no manifest grant, it is this extension's own code.

const json = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

// An editor URL when the engine is ready, else the state that stands in the way (a 409, not a failure).
export const openDocument = async (request: OpenRequest): Promise<OpenResult> => {
    const response = await host().sandbox.request(`${NAMESPACE}/open`, json(request));
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
    const response = await host().sandbox.request(`${NAMESPACE}/start`, json({ engine }));
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return (await response.json()) as DocsState;
};

// Writes what a document server session's editor holds to the workspace now, for an editor the viewer keeps alive out
// of sight. A browser-engine editor is told by message instead (EditorSlot).
export const forceSaveDocument = async (request: ForceSaveRequest): Promise<void> => {
    const response = await host().sandbox.request(`${NAMESPACE}/forcesave`, json(request));
    if (!response.ok) {
        throw new Error(await response.text());
    }
};
