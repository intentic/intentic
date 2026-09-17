import { NAMESPACE, type DocsState, type OpenRequest, type OpenResult } from "./contract.js";
import { host } from "./host.js";

// The viewer's two calls into its own backend; the namespace needs no manifest grant, it is this extension's own code.

const json = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

// An editor URL when the document server is ready, else the state that stands in the way (a 409, not a failure).
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

// The owner's one explicit act: pull the image and start the server. Returns as soon as the pull is under way.
export const startDocs = async (): Promise<DocsState> => {
    const response = await host().sandbox.request(`${NAMESPACE}/start`, { method: `POST` });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return (await response.json()) as DocsState;
};
