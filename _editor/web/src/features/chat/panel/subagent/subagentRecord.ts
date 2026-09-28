import type { TranscriptRow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { Conversation } from "../../session/conversation";

// AN IN-PROCESS SUBAGENT'S TRANSCRIPT, HELD AS A CONVERSATION NOBODY CAN SEND TO, so the chat draws it with its own rows
// (ChatPaneTurns, ChatMessageView): the same cards, thinking and prose as the parent's column, rather than a second
// renderer that would drift from the first. It is never a tab and never mirrored to disk: its rows are the daemon's
// read, replaced whole on each one (`rebuild`, which writes nothing locally), and no turn ever runs on it.
//
// Its paths are its parent's: the subagent worked in the parent's checkout and box, so its file links, pictures and
// terminal resolve there.

export const subagentRecord = (parent: Conversation, subagentId: string): Conversation => {
    const record = new Conversation(`subagent:${subagentId}`);
    // The one fact a Conversation derives from its own identity: whose checkout its paths name. Here, the parent's.
    Object.defineProperty(record, `scope`, { value: computed(() => parent.scope.value) });
    record.box.value = parent.box.value;
    record.isolated.value = parent.isolated.value;
    record.agentTerminal.value = parent.agentTerminal.value;
    record.agentBrowser.value = parent.agentBrowser.value;
    return record;
};

/** Puts the daemon's latest read in place, whole; a read identical to what is drawn changes nothing. */
export const showRecord = (record: Conversation, rows: readonly TranscriptRow[], drawn: { last: string | undefined }): void => {
    const next = JSON.stringify(rows);
    if (next === drawn.last) {
        return;
    }
    drawn.last = next;
    record.transcript.rebuild(rows);
};
