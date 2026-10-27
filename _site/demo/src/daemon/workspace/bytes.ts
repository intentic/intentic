import { deskEdition, freshEdition } from "../../mode";
import { SEPTEMBER_PRINT_DOCX, SEPTEMBER_PRINT_PATH, SUPPLIER_LETTER_DOCX, SUPPLIER_LETTER_PATH } from "../../fixture/desk";
import { HANDOVER_CHANGE_PATH, HANDOVER_DOCX, HANDOVER_PATH } from "../../fixture/document";
import { PAGE_FILES } from "../../fixture/pages";
import { fileBody, workspaceEntries } from "../../fixture/workspace";

// A file's bytes, as the derived-text reader and an upload's later parts read them. The file table keeps text, or a size
// for a file it only lists; the few files whose bytes are bytes (the Word documents, a synthesised sound, whatever a
// visitor drops) are answered from here, so a picture draws and a document opens from what was really dropped.

const BYTES = new Map<string, Uint8Array<ArrayBuffer>>();

/** A dropped or copied binary: its bytes here, its size in the table so the tree lists it. */
export const holdBytes = (path: string, bytes: Uint8Array<ArrayBuffer>): void => {
    BYTES.set(path, bytes);
    workspaceEntries().set(path, bytes.length);
};

/** A file written as text since: its old bytes no longer answer for it. */
export const releaseBytes = (path: string): void => {
    BYTES.delete(path);
};

const branch = (root: string): string[] => [...BYTES.keys()].filter((path) => path === root || path.startsWith(`${root}/`));

export const moveBytes = (from: string, to: string): void => {
    const bytes = BYTES.get(from);
    if (bytes !== undefined) {
        BYTES.delete(from);
        BYTES.set(to, bytes);
    }
};

export const copyBytes = (from: string, to: string): void => {
    const bytes = BYTES.get(from);
    if (bytes !== undefined) {
        BYTES.set(to, bytes);
    }
};

// A delete keeps the bytes the trash may give back: a restore lands the size row at the same path, and the bytes
// still answer for it. Only a file the table no longer lists anywhere is let go.
export const forgetBytes = (root: string): void => {
    for (const path of branch(root)) {
        if (!workspaceEntries().has(path)) {
            BYTES.delete(path);
        }
    }
};

// Two notes of a till's chime, as 16-bit mono PCM in a WAV container: something a player really plays, made here
// rather than shipped, so the demo stays a few kilobytes.
const SAMPLE_RATE = 22_050;
const chime = (): Uint8Array<ArrayBuffer> => {
    const notes = [
        { hz: 880, at: 0, length: 0.6 },
        { hz: 1_318.5, at: 0.18, length: 0.9 },
    ];
    const samples = Math.round(SAMPLE_RATE * 1.1);
    const wav = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset: number, value: string): void => {
        for (const [index, char] of [...value].entries()) {
            wav.setUint8(offset + index, char.charCodeAt(0));
        }
    };
    text(0, `RIFF`);
    wav.setUint32(4, 36 + samples * 2, true);
    text(8, `WAVEfmt `);
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, 1, true);
    wav.setUint32(24, SAMPLE_RATE, true);
    wav.setUint32(28, SAMPLE_RATE * 2, true);
    wav.setUint16(32, 2, true);
    wav.setUint16(34, 16, true);
    text(36, `data`);
    wav.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index += 1) {
        const time = index / SAMPLE_RATE;
        const value = notes.reduce((sum, note) => {
            const local = time - note.at;
            return local < 0 || local > note.length ? sum : sum + Math.sin(2 * Math.PI * note.hz * local) * Math.exp(-local * 5);
        }, 0);
        wav.setInt16(44 + index * 2, Math.max(-1, Math.min(1, value * 0.4)) * 32_767, true);
    }
    return new Uint8Array(wav.buffer);
};

/** The order-placed sound the shop's checkout plays: a real recording in the tree, read like any other. */
const CHIME_PATH = `web/public/sounds/order-placed.wav`;

// Seeded into the shop's tree only: a desk is documents, and a fresh sandbox has nothing yet.
if (!deskEdition && !freshEdition) {
    holdBytes(CHIME_PATH, chime());
}

const DOCUMENTS = new Map<string, Uint8Array<ArrayBuffer>>([
    [SUPPLIER_LETTER_PATH, SUPPLIER_LETTER_DOCX],
    [SEPTEMBER_PRINT_PATH, SEPTEMBER_PRINT_DOCX],
    [HANDOVER_PATH, HANDOVER_DOCX],
    [HANDOVER_CHANGE_PATH, HANDOVER_DOCX],
]);

/** The bytes at `path`, or undefined when nothing is there. */
export const bytesOf = (path: string): Uint8Array<ArrayBuffer> | undefined => {
    const held = BYTES.get(path) ?? DOCUMENTS.get(path);
    if (held !== undefined) {
        return held;
    }
    const text = PAGE_FILES.get(path) ?? fileBody(path);
    return text === undefined ? undefined : new TextEncoder().encode(text);
};
