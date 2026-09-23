import { ref } from "vue";
import type { PendingAttachment } from "./useChatAttachments";

// Pins the paperclip's road in: every picked file is staged and sent up to its own place under the attachments tree,
// and the picker is emptied, so picking the same file again is still a pick. The bytes' own upload is stood in for.

const sandboxUpload = jest.fn<(route: string, body: Blob, options?: unknown) => Promise<void>>(async () => undefined);
jest.mock("../../sandbox/client/sandboxClient", () => ({ sandboxUpload, sandboxBlob: jest.fn() }));
const { useChatAttachments } = await import("./useChatAttachments");

// A file input's change as the browser dispatches it: the files picked, and the value naming the last of them.
const picked = (...names: string[]) => {
    const picker = { files: names.map((name) => new File([`bytes`], name, { type: `text/plain` })), value: `C:\\fakepath\\${names.at(-1)}` };
    return { picker, event: { target: picker } as unknown as Event };
};

it(`stages every picked file for upload and empties the picker`, () => {
    const attachments = ref<PendingAttachment[]>([]);
    const staging = useChatAttachments({ attachments, reachable: ref(true), connected: ref(true), at: ref(`box-2`) });
    const { picker, event } = picked(`notes.txt`, `todo.txt`);

    staging.onPick(event);

    expect(attachments.value.map((attachment) => [attachment.name, attachment.status])).toEqual([
        [`notes.txt`, `uploading`],
        [`todo.txt`, `uploading`],
    ]);
    expect(sandboxUpload.mock.calls.map(([route]) => route)).toEqual(
        attachments.value.map((attachment) => `/workspace/upload?path=${encodeURIComponent(attachment.path)}`),
    );
    expect(picker.value).toBe(``);
});

it(`stages nothing with no daemon to hold the bytes, and still empties the picker`, () => {
    const attachments = ref<PendingAttachment[]>([]);
    const staging = useChatAttachments({ attachments, reachable: ref(false), connected: ref(true), at: ref(undefined) });
    const { picker, event } = picked(`notes.txt`);

    staging.onPick(event);

    expect(attachments.value).toEqual([]);
    expect(picker.value).toBe(``);
});
