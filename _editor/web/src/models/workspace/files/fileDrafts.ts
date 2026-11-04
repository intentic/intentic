import { sandboxShallowRef } from "@intentic/extension-api";
import type { Ref } from "vue";
import { scopeKey, type ViewScope } from "../../../app/workspaceScope";
import type { FileDraftView } from "../../conversations/session/turnLiveState";

// The files agents are writing right now, by the copy each writes into, for a viewer open on one to draw the text as it
// streams in (file_draft facts, the daemon's agent/pages/file-draft.ts). Each conversation's drafts stay its turn's own
// (TurnClient.fileDrafts, cleared when the turn settles); this only says where to find them, so a draft can never
// outlive the turn that wrote it. Live state, speculative until the call settles, never written anywhere.

interface DraftSource {
    // The copy the conversation writes: its own checkout when isolated, the shared tree when not. Read when asked,
    // since a conversation's placement is known only once its first turn says so.
    readonly scope: () => ViewScope;
    readonly drafts: Readonly<Ref<ReadonlyMap<string, FileDraftView>>>;
}

// By conversation id; one sandbox's, so a switch forgets the last one's.
const sources = sandboxShallowRef<ReadonlyMap<string, DraftSource>>(() => new Map());

/* A CONVERSATION'S DRAFTS, FINDABLE BY FILE. Called on its turn's first file_draft fact; once is enough, since the
   drafts are read through the turn's own ref. */
export const followFileDrafts = (conversationId: string, source: DraftSource): void => {
    const held = sources.value.get(conversationId);
    if (held?.drafts === source.drafts) {
        return;
    }
    sources.value = new Map(sources.value).set(conversationId, source);
};

/* THE DRAFT OVER ONE FILE IN ONE COPY, the latest-started when two calls write it at once; undefined when nothing is
   writing it. Reactive: a viewer reading it redraws on each stretch. */
export const fileDraftOf = (path: string, scope: ViewScope): FileDraftView | undefined => {
    const key = scopeKey(scope);
    let found: FileDraftView | undefined;
    for (const source of sources.value.values()) {
        // The drafts first: reading them is what makes a viewer redraw when the first one for its file arrives.
        const drafts = source.drafts.value;
        if (drafts.size === 0 || scopeKey(source.scope()) !== key) {
            continue;
        }
        for (const draft of drafts.values()) {
            if (draft.path === path) {
                found = draft;
            }
        }
    }
    return found;
};

/* THE FILE AS THE DRAFT WOULD LEAVE IT: a write's text so far, or `base` with an edit's old text replaced by its
   replacement so far (every occurrence when the edit says so, else the first). Undefined when it cannot be placed: an
   edit whose old text has not arrived, was too long to send, or is not in `base`, which is then what to show. An edit
   with no old text writes a new file, as Claude Code's Edit does, so it stands only over a file that is empty or not
   there. */
export const draftedText = (base: string | undefined, draft: FileDraftView): string | undefined => {
    if (draft.op === `write`) {
        return draft.text;
    }
    if (draft.old === undefined) {
        return undefined;
    }
    if (draft.old === ``) {
        return base === undefined || base === `` ? draft.text : undefined;
    }
    if (base === undefined) {
        return undefined;
    }
    if (draft.replaceAll === true) {
        return base.includes(draft.old) ? base.split(draft.old).join(draft.text) : undefined;
    }
    const at = base.indexOf(draft.old);
    return at === -1 ? undefined : base.slice(0, at) + draft.text + base.slice(at + draft.old.length);
};
