import { useNoteDraft } from "@intentic/ui";
import { effectScope, ref } from "vue";

/* What <NoteEditor> relies on now that a note writes itself as it is typed: the writes made while typing leave the reader
   writing, the one made on the way out closes the draft, and leaving a note you only clicked into writes nothing. */
const noteOf = (onDisk: string) => {
    const raw = ref(onDisk);
    const draft = ref<string | undefined>(undefined);
    const writes: string[] = [];
    let land: (() => void) | undefined;
    // Each write waits to be landed, so a test can leave while one is still on its way.
    const save = (content: string): Promise<void> =>
        new Promise<void>((resolve) => {
            land = () => {
                writes.push(content);
                resolve();
            };
        });
    const scope = effectScope();
    const note = scope.run(() => useNoteDraft({ draft, raw: () => raw.value, save, remove: async () => undefined }))!;
    return { raw, draft, writes, note, scope, landWrite: () => land?.() };
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

it(`writes as it is typed without closing, and closes once left`, async () => {
    const { draft, writes, note, scope, landWrite } = noteOf(`# Note\n`);
    note.startEdit();
    draft.value = `# Note\nMore.\n`;
    const typing = note.saveDraft(true);
    await settle();
    landWrite();
    await typing;
    expect(writes).toEqual([`# Note\nMore.\n`]);
    expect(note.editing.value).toBe(true);

    // Left with nothing new since: closed without writing the same words again, before the file is read back.
    await note.saveDraft();
    expect(writes).toHaveLength(1);
    expect(note.editing.value).toBe(false);
    scope.stop();
});

it(`writes nothing when a note was only clicked into`, async () => {
    const { writes, note, scope } = noteOf(`# Note\n`);
    note.startEdit();
    await note.saveDraft();
    expect(writes).toEqual([]);
    expect(note.editing.value).toBe(false);
    scope.stop();
});

// Leaving mid-save is the common case (the last keystroke's write is on its way when the pointer moves on): the leave
// waits for it, then writes what was typed after it, then closes.
it(`leaves mid-save without losing what came after, and still closes`, async () => {
    const { draft, writes, note, scope, landWrite } = noteOf(`a`);
    note.startEdit();
    draft.value = `ab`;
    const typing = note.saveDraft(true);
    await settle();
    // "ab" is on its way when "c" is typed and the reader leaves.
    draft.value = `abc`;
    const leaving = note.saveDraft();
    landWrite();
    await typing;
    await settle();
    landWrite();
    await leaving;
    expect(writes).toEqual([`ab`, `abc`]);
    expect(note.editing.value).toBe(false);
    scope.stop();
});
