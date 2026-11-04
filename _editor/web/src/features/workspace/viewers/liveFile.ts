import { sandboxRef } from "@intentic/extension-api";
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { scopeKey, type ViewScope } from "../../../app/workspaceScope";
import { agentById } from "../../../models/fleet/useAgents-fleet";
import { draftedText, fileDraftOf } from "../../../models/workspace/files/fileDrafts";

/* A FILE BEING WRITTEN WHILE IT IS OPEN: an agent rewriting the document a reader is watching, in its own copy or in
   the shared tree. The viewer then redraws in place rather than starting over (FileViewer), marks what changed, and,
   where the reader asked to follow the edits, brings each change into view. Every surface reads the one choice off an
   ancestor's `data-follow-edits` (the viewers extension's load/liveSwap.ts, CodeView, MarkdownViewer), so no viewer
   needs this module.

   Live is either a conversation's copy while its turn runs, or a file that changed within the last half minute: a
   turn on the shared tree has no copy of its own to point at, and a file nobody is writing any more needs no badge. */

// The reader's choice for every live file in this sandbox: taken to each edit as it lands (the default, since watching
// the agent write is why the file is open), or left where they are reading.
export const followEdits = sandboxRef(() => true);

// How long a changed file reads as live after its last change.
const LIVE_FOR_MS = 30_000;
// How long writes must go quiet before the file is read once more. A document written in several strokes (a zip
// rewritten in place, a script saving each section) is caught half-written by the read its first stroke set off;
// this read is the one that sees it whole.
export const SETTLE_MS = 800;

export interface LiveFile {
    // Whether the file is being written now, which is when the Live chip shows.
    readonly live: Readonly<Ref<boolean>>;
    // Runs `read` once the file's writes have been quiet for SETTLE_MS; each call starts the wait over. Dropped with the
    // surface.
    readonly settle: (read: () => void) => void;
}

/** `epoch` is the file's change count in the copy shown (changeEpochOf); a move after the first reading means it changed. */
export const useLiveFile = (scope: () => ViewScope, epoch: () => number): LiveFile => {
    const changedAt = ref<number>();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let settling: ReturnType<typeof setTimeout> | undefined;

    watch(epoch, () => {
        changedAt.value = Date.now();
        clearTimeout(quiet);
        quiet = setTimeout(() => (changedAt.value = undefined), LIVE_FOR_MS);
    });
    // Another file or another copy on the same surface starts with nothing changed.
    watch(() => scopeKey(scope()), () => {
        changedAt.value = undefined;
        clearTimeout(settling);
    });

    const running = computed(() => {
        const agent = scope().agent;
        return agent !== undefined && agentById(agent)?.status === `running`;
    });
    const live = computed(() => running.value || changedAt.value !== undefined);

    const settle = (read: () => void): void => {
        clearTimeout(settling);
        settling = setTimeout(read, SETTLE_MS);
    };

    onScopeDispose(() => {
        clearTimeout(quiet);
        clearTimeout(settling);
    });

    return { live, settle };
};

/** Whether two readings of a file hold the same bytes, so a read that found nothing new redraws nothing. */
export const sameBytes = async (a: Blob, b: Blob): Promise<boolean> => {
    if (a.size !== b.size) {
        return false;
    }
    const [left, right] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
    const x = new Uint8Array(left);
    const y = new Uint8Array(right);
    for (let index = 0; index < x.length; index += 1) {
        if (x[index] !== y[index]) {
            return false;
        }
    }
    return true;
};

// One fresh reading of a viewer's file, as FileViewer sorted it: what it read, no file there, or a read that failed
// another way (or was superseded), which leaves the rendering as it is.
export type ViewerReading<C> = { readonly kind: `read`; readonly content: C } | { readonly kind: `missing` } | { readonly kind: `failed` };

// Whether two readings hold the same bytes or the same text; anything else (a streamed file's address) differs.
const sameBody = async (held: Blob | string | undefined, loaded: Blob | string | undefined): Promise<boolean> => {
    if (held instanceof Blob && loaded instanceof Blob) {
        return sameBytes(held, loaded);
    }
    // Blobs from two reads are two objects; only a text can be equal by value here.
    return held !== undefined && held === loaded;
};

export interface ViewerRefreshDeps<C> {
    // A fresh reading of the file, the way the viewer's manifest asks for it.
    readonly read: (path: string) => Promise<ViewerReading<C>>;
    // What the viewer draws now, and the bytes or text a reading carries, to tell a reading that found nothing new.
    readonly held: () => C | undefined;
    readonly body: (content: C) => Blob | string | undefined;
    readonly adopt: (content: C) => void;
    // FileViewer's own superseding: a read answering after a newer one lands nowhere.
    readonly latest: () => () => boolean;
    readonly gone: (path: string) => void;
    // Whether the surface still shows this file as a viewer, for the settled read that comes later.
    readonly stillOn: (path: string) => boolean;
    readonly settle: LiveFile[`settle`];
}

/**
 * A drawn viewer's answer to its file changing on disk: the new bytes handed to the viewer it already is, which draws
 * them over its last rendering (the viewers' useViewerLoad), rather than a spinner and a fresh mount per write. Once the
 * writes go quiet the file is read once more (`settle`), since the read a write set off may have caught it half
 * written; a reading that holds what is drawn redraws nothing. A file missing mid-write is only gone if the settled read
 * says so too, and a read that fails otherwise leaves the rendering as it is.
 */
export const viewerRefresh = <C>(deps: ViewerRefreshDeps<C>): ((path: string) => void) => {
    const refresh = async (path: string, settled: boolean): Promise<void> => {
        if (!settled) {
            deps.settle(() => {
                if (deps.stillOn(path)) {
                    void refresh(path, true);
                }
            });
        }
        const isLatest = deps.latest();
        const reading = await deps.read(path);
        if (!isLatest()) {
            return;
        }
        if (reading.kind === `missing` && settled) {
            deps.gone(path);
            return;
        }
        if (reading.kind !== `read`) {
            return;
        }
        const held = deps.held();
        const same = held !== undefined && (await sameBody(deps.body(held), deps.body(reading.content)));
        if (isLatest() && !same) {
            deps.adopt(reading.content);
        }
    };
    return (path) => void refresh(path, false);
};

// How long a draft's last text stands after its call settled, waiting for the file's own text to take its place: the
// settle comes a moment before the read it sets off lands, and dropping the draft at once would flash the old text.
const DRAFT_HOLD_MS = 3000;

export interface DraftSeed {
    // The text to show while the agent is writing the file, as far as its call has streamed; undefined otherwise.
    readonly text: Readonly<Ref<string | undefined>>;
    // Whether a call is writing the file now.
    readonly writing: Readonly<Ref<boolean>>;
}

/**
 * THE FILE AS THE AGENT IS WRITING IT (file_draft facts, fileDrafts.ts): a Write's text as it streams, or the file with
 * an Edit's replacement typed into place, for a text surface nobody is typing into (`applies`, FileViewer's
 * followsSeed). Speculative until the call settles, which is why it is a seed and never a buffer: the file on disk,
 * read when the call lands, replaces it.
 */
export const useDraftSeed = (path: () => string, scope: () => ViewScope, base: () => string | null, applies: () => boolean): DraftSeed => {
    const draft = computed(() => (applies() ? fileDraftOf(path(), scope()) : undefined));
    const held = ref<string>();
    let release: ReturnType<typeof setTimeout> | undefined;
    watch(
        () => (draft.value === undefined ? undefined : draftedText(base() ?? undefined, draft.value)),
        (drafted) => {
            clearTimeout(release);
            if (drafted !== undefined) {
                held.value = drafted;
            } else if (held.value !== undefined) {
                release = setTimeout(() => (held.value = undefined), DRAFT_HOLD_MS);
            }
        },
    );
    // The file's own text landing is the answer the draft stood in for.
    watch(base, () => {
        if (draft.value === undefined) {
            clearTimeout(release);
            held.value = undefined;
        }
    });
    onScopeDispose(() => clearTimeout(release));
    return { text: held, writing: computed(() => draft.value !== undefined) };
};
