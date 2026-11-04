import type { EditorContext } from "@intentic/sandbox-contract/schemas/agent";
import { mentionPaths } from "@intentic/sandbox-contract/text/mentions";
import type { TurnErrand } from "@intentic/sandbox-contract/schemas/speaker";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import { sentFrom } from "../drafts/composerDrafts";
import type { TurnBooking } from "../drafts/sendLater";
import { type ForkLink, openingAnswers, type SessionRef, type TurnSettings, turnRequestBody } from "./turnRequest";
import type { ChatAttachment } from "../transcript/transcript";
import type { TurnHost } from "../session/turnHost";

// One message as the composer hands it to the turn client.
export interface OutgoingMessage {
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    readonly messageId: string;
    readonly editorContext: EditorContext | undefined;
}

// What the message goes out for, beyond its words.
export interface MessageOccasion {
    readonly opened?: { readonly settings: TurnSettings; readonly session: SessionRef | undefined };
    readonly forkOf?: ForkLink | undefined;
    readonly errand?: TurnErrand | undefined;
    readonly booking?: TurnBooking | undefined;
}

// The request one message goes out as. A send names the settings and session its turn opened on (`opened`); words
// said beside a live turn, or queued behind words still waiting, go on the composer's as they stand. Chips and
// @-mentions ride apart, since only a chip was chosen; mentions skip chips, already visible inline.
export const messageRequestBody = (host: TurnHost, message: OutgoingMessage, occasion: MessageOccasion = {}): ProcedureInput<`agent.run`> => {
    const attachmentPaths = message.attachments.map((file) => file.path);
    return turnRequestBody({
        messageId: message.messageId,
        text: message.text,
        conversationId: host.conversationId,
        title: host.title.value,
        isolated: host.isolated.value,
        runner: host.runner.value,
        box: host.box.value,
        mode: host.selection.mode.value,
        settings: occasion.opened?.settings ?? host.selection.turnSettings(),
        registered: host.registered.value,
        session: occasion.opened === undefined ? host.session.value : occasion.opened.session,
        forkOf: occasion.forkOf,
        attachmentPaths,
        mentionedPaths: mentionPaths(message.text).filter((path) => !attachmentPaths.includes(path)),
        editorContext: message.editorContext,
        errand: occasion.errand,
        booking: occasion.booking,
        ...openingAnswers(host),
        // Read as the words leave: the draft they were typed into, which the daemon clears with them.
        draft: sentFrom(host.conversationId),
    });
};
