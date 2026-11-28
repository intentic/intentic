import { S2S_MESSAGE_BYTES_MAX, S2S_MESSAGE_FILES_MAX } from "@intentic/sandbox-contract/schemas/s2s";
import type { S2sAttachment } from "@intentic/sandbox-contract/schemas/s2s";
import { errorMessage } from "@intentic/base/errors";
import { formatBytes } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { computed, type MaybeRefOrGetter, ref, shallowRef, toValue } from "vue";
import { type S2sMessageSendInput, useMessagesApi } from "../../../../models/messages/messagesApi";
import { threadsChanged } from "../../../../models/messages/useMessages";

// ONE MESSAGE BEING WRITTEN: its words, an optional subject (a new thread's only; a reply keeps its thread's), and the
// files picked for it, held to the drops' limits before anything is sent (S2S_MESSAGE_FILES_MAX files, S2S_MESSAGE_BYTES_MAX
// in all). Sending files it in the outbox and answers at once: queued, refused in words, or held for a person's yes
// (an agent's send under the guard; a person's own never is, but the answer is read as the contract allows).

/** Where the message goes: a contact, and the thread it continues, if any. */
export interface ComposerTarget {
    readonly to: string | undefined;
    readonly thread: string | undefined;
}

/** How a send ended, for the line under the composer. */
export type SendResult = { readonly state: `queued`; readonly thread: string } | { readonly state: `refused` | `asked`; readonly reason: string };

/** A file's bytes as base64, read in slices so a large one never builds one enormous argument list. */
export const base64Of = async (file: Blob): Promise<string> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const SLICE = 0x8000;
    let binary = ``;
    for (let at = 0; at < bytes.length; at += SLICE) {
        binary += String.fromCharCode(...bytes.subarray(at, at + SLICE));
    }
    return btoa(binary);
};

/** Why these files cannot go together, or undefined when they can. */
export const filesProblem = (files: readonly Pick<File, `size`>[]): string | undefined => {
    if (files.length > S2S_MESSAGE_FILES_MAX) {
        return t(`sandbox.messages.composer.tooManyFiles`, { max: S2S_MESSAGE_FILES_MAX });
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    return total > S2S_MESSAGE_BYTES_MAX ? t(`sandbox.messages.composer.tooLarge`, { max: formatBytes(S2S_MESSAGE_BYTES_MAX) }) : undefined;
};

export const useComposer = (target: MaybeRefOrGetter<ComposerTarget>) => {
    const api = useMessagesApi();
    const text = ref(``);
    const subject = ref(``);
    const files = shallowRef<readonly File[]>([]);
    const sending = ref(false);
    const result = shallowRef<SendResult>();
    const failure = ref<string>();

    const problem = computed(() => filesProblem(files.value));
    const ready = computed(() => toValue(target).to !== undefined && (text.value.trim() !== `` || files.value.length > 0) && problem.value === undefined);

    /** Adds picked files, a file of the same name replacing the one already there. */
    const addFiles = (picked: readonly File[]): void => {
        const names = new Set(picked.map((file) => file.name));
        files.value = [...files.value.filter((file) => !names.has(file.name)), ...picked];
    };
    const removeFile = (name: string): void => {
        files.value = files.value.filter((file) => file.name !== name);
    };

    const send = async (): Promise<SendResult | undefined> => {
        const { to, thread } = toValue(target);
        if (to === undefined || !ready.value || sending.value) {
            return undefined;
        }
        sending.value = true;
        failure.value = undefined;
        result.value = undefined;
        try {
            const attachments: S2sAttachment[] = await Promise.all(files.value.map(async (file) => ({ name: file.name, data: await base64Of(file) })));
            const message: S2sMessageSendInput = { to, text: text.value, files: attachments };
            const titled = subject.value.trim();
            if (thread !== undefined) {
                message.thread = thread;
            } else if (titled !== ``) {
                message.subject = titled;
            }
            const outcome = await api.send(message);
            const ended: SendResult = outcome.state === `queued` ? { state: `queued`, thread: outcome.thread } : { state: outcome.state, reason: outcome.reason };
            result.value = ended;
            if (ended.state === `queued`) {
                text.value = ``;
                subject.value = ``;
                files.value = [];
            }
            void threadsChanged();
            return ended;
        } catch (error) {
            failure.value = errorMessage(error);
            return undefined;
        } finally {
            sending.value = false;
        }
    };

    return { text, subject, files, sending, result, failure, problem, ready, addFiles, removeFile, send };
};
