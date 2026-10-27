import type {
    WorkspaceSearchFrame,
    WorkspaceSearchGroup,
    WorkspaceSearchResult,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { shallowRef } from "vue";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

// A text search's first page, streamed (workspace.searchStream): the files the daemon finds are handed to `onGroups` as
// they arrive, and the page it finishes with is the answer, the same one workspace.search gives, whose cursor pages on.
// Where the stream route is not there to answer (a folder on this computer, whose server answers only the plain search;
// a sandbox from before it), the plain search answers instead, and is asked directly from then on.

export interface SearchCalls {
    readonly stream: (input: ProcedureInput<`workspace.search`>, signal: AbortSignal | undefined) => Promise<AsyncIterable<WorkspaceSearchFrame>>;
    readonly search: (input: ProcedureInput<`workspace.search`>, signal: AbortSignal | undefined) => Promise<WorkspaceSearchResult>;
}

export type FirstTextPage = (
    input: ProcedureInput<`workspace.search`>,
    signal: AbortSignal | undefined,
    onGroups: (groups: readonly WorkspaceSearchGroup[]) => void,
) => Promise<WorkspaceSearchResult>;

export const firstTextPages = (calls: SearchCalls): FirstTextPage => {
    // One answer that has no stream route is enough to know for as long as these calls last.
    let streamless = false;
    return async (input, signal, onGroups) => {
        if (streamless) {
            return calls.search(input, signal);
        }
        let frames: AsyncIterable<WorkspaceSearchFrame>;
        try {
            frames = await calls.stream(input, signal);
        } catch (error) {
            if (error instanceof SandboxHttpError && error.status === 404) {
                streamless = true;
                return calls.search(input, signal);
            }
            throw error;
        }
        for await (const frame of frames) {
            if (frame.kind === `done`) {
                return frame.result;
            }
            onGroups(frame.groups);
        }
        // A stream that closed without its answer (the daemon restarting under it) is asked once more, plainly.
        return calls.search(input, signal);
    };
};

// The files a streaming search has found so far, for the search they belong to (its key), until its page arrives.
interface Provisional {
    readonly key: string;
    readonly groups: readonly WorkspaceSearchGroup[];
}

export interface StreamingPages {
    // One page of a search: a text search's first one streamed, every other page and every other kind one plain answer.
    readonly pageOf: (search: ProcedureInput<`workspace.search`>, after: string | undefined, signal: AbortSignal) => Promise<WorkspaceSearchResult>;
    // What the streaming search `search` has found so far (reactive); undefined once its page is in, or for any other.
    readonly foundFor: (search: ProcedureInput<`workspace.search`>) => readonly WorkspaceSearchGroup[] | undefined;
}

export const streamingPages = (firstPage: FirstTextPage, plain: SearchCalls[`search`]): StreamingPages => {
    const provisional = shallowRef<Provisional | undefined>();
    const keyOf = (search: ProcedureInput<`workspace.search`>): string => JSON.stringify(search);
    return {
        pageOf: async (search, after, signal) => {
            if (search.mode !== `find` || after !== undefined) {
                return plain({ ...search, after }, signal);
            }
            const key = keyOf(search);
            try {
                return await firstPage(search, signal, (groups) => {
                    const before = provisional.value?.key === key ? provisional.value.groups : [];
                    provisional.value = { key, groups: [...before, ...groups] };
                });
            } finally {
                if (provisional.value?.key === key) {
                    provisional.value = undefined;
                }
            }
        },
        foundFor: (search) => {
            const found = provisional.value;
            return found !== undefined && found.key === keyOf(search) ? found.groups : undefined;
        },
    };
};
