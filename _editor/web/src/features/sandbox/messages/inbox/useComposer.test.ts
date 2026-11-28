import type { S2sMessageSendOutcome } from "@intentic/sandbox-contract/schemas/s2s";
import { S2S_MESSAGE_BYTES_MAX, S2S_MESSAGE_FILES_MAX } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { inSetup, provided } from "../../../../testing/inSetup";
import { MESSAGES_API, type MessagesApi, type S2sMessageSendInput } from "../../../../models/messages/messagesApi";
import { type ComposerTarget, base64Of, filesProblem, useComposer } from "./useComposer";

// One message being written: held to the drops' limits before anything is sent, its files carried as base64 under their
// own names, a reply sent into its thread without a subject of its own, and the draft cleared only once the outbox took it.

const THREAD = `t-research`;

const composerWith = (answer: (message: S2sMessageSendInput) => S2sMessageSendOutcome, target: ComposerTarget = { to: `c-research`, thread: undefined }) => {
    const sent: S2sMessageSendInput[] = [];
    const api = unstubbed<MessagesApi>(`messages`, {
        send: async (message) => {
            sent.push(message);
            return answer(message);
        },
    });
    const { result } = inSetup(() => useComposer(target), { provides: [provided(MESSAGES_API, api)] });
    return { composer: result, sent };
};

const queued = (): S2sMessageSendOutcome => ({ state: `queued`, id: `0190a5b2-0000-7000-8000-000000000001`, thread: THREAD });

it(`sends a new thread's subject, the words and each file as base64 under its own name`, async () => {
    const { composer, sent } = composerWith(queued);
    composer.text.value = `The figures for October`;
    composer.subject.value = `  October  `;
    composer.addFiles([new File([`a,b\n1,2\n`], `october.csv`)]);
    expect(await composer.send()).toEqual({ state: `queued`, thread: THREAD });
    expect(sent).toEqual([{ to: `c-research`, text: `The figures for October`, subject: `October`, files: [{ name: `october.csv`, data: btoa(`a,b\n1,2\n`) }] }]);
    // Taken by the outbox: the draft is empty again.
    expect([composer.text.value, composer.subject.value, composer.files.value.length]).toEqual([``, ``, 0]);
});

it(`sends a reply into its thread, with no subject of its own`, async () => {
    const { composer, sent } = composerWith(queued, { to: `c-research`, thread: THREAD });
    composer.text.value = `Thanks`;
    composer.subject.value = `ignored`;
    await composer.send();
    expect(sent).toEqual([{ to: `c-research`, text: `Thanks`, thread: THREAD, files: [] }]);
});

it(`keeps the draft when the send is refused, and says why`, async () => {
    const { composer } = composerWith(() => ({ state: `refused`, reason: `They no longer take messages from this sandbox.` }));
    composer.text.value = `Hello?`;
    expect(await composer.send()).toEqual({ state: `refused`, reason: `They no longer take messages from this sandbox.` });
    expect(composer.text.value).toBe(`Hello?`);
});

it(`sends nothing with no contact, no words and no files`, async () => {
    const { composer, sent } = composerWith(queued, { to: undefined, thread: undefined });
    composer.text.value = `to nobody`;
    expect(composer.ready.value).toBe(false);
    expect(await composer.send()).toBeUndefined();
    const empty = composerWith(queued);
    expect(empty.composer.ready.value).toBe(false);
    expect([sent.length, empty.sent.length]).toEqual([0, 0]);
});

it(`replaces a picked file of the same name rather than sending it twice`, () => {
    const { composer } = composerWith(queued);
    composer.addFiles([new File([`one`], `notes.txt`), new File([`x`], `a.png`)]);
    composer.addFiles([new File([`two`], `notes.txt`)]);
    expect(composer.files.value.map((file) => [file.name, file.size])).toEqual([
        [`a.png`, 1],
        [`notes.txt`, 3],
    ]);
    composer.removeFile(`a.png`);
    expect(composer.files.value.map((file) => file.name)).toEqual([`notes.txt`]);
});

it(`holds files past the drops' limits, at the limit itself still going`, () => {
    const sized = (size: number) => ({ size });
    expect(filesProblem(Array.from({ length: S2S_MESSAGE_FILES_MAX }, () => sized(1)))).toBeUndefined();
    expect(filesProblem(Array.from({ length: S2S_MESSAGE_FILES_MAX + 1 }, () => sized(1)))).toBe(`At most 20 files in one message`);
    expect(filesProblem([sized(S2S_MESSAGE_BYTES_MAX)])).toBeUndefined();
    expect(filesProblem([sized(S2S_MESSAGE_BYTES_MAX), sized(1)])).toBe(`At most 10 MB of files in one message`);
});

it(`carries bytes past one slice of the reader whole`, async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, at) => at % 251);
    const decoded = Uint8Array.from(atob(await base64Of(new Blob([bytes]))), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
});
