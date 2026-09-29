import { sandboxShallowRef } from "@intentic/extension-api";

// Which web pages the reader asked to see rendered rather than as source, by workspace path, for this window's session.
// A page opened from the files shows its source first, as it always has: there it is as often being edited as read. One
// opened from a turn's documents (ChatTurnDeliverables) or followed from a link inside a preview opens rendered, since
// whoever opens it there wants the page. Per sandbox, since a path means a file in one sandbox's workspace.

const rendered = sandboxShallowRef<ReadonlySet<string>>(() => new Set());

export const htmlPreviewed = (path: string): boolean => rendered.value.has(path);

export const setHtmlPreviewed = (path: string, on: boolean): void => {
    if (rendered.value.has(path) === on) {
        return;
    }
    const next = new Set(rendered.value);
    if (on) {
        next.add(path);
    } else {
        next.delete(path);
    }
    rendered.value = next;
};
