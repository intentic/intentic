import { unzipSync } from "fflate";
import type { WorkspaceDerived } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { archiveMembers, fileBody } from "../../fixture/workspace";
import { bytesOf } from "./bytes";
import { pushDerived } from "./workspaceBroadcast";

// The text shadow fileq keeps beside a document, picture, recording or archive: nothing until someone asks, then the
// file read as markdown and kept until the file changes. A Word document is unzipped and its paragraphs read; an
// archive lists what it holds; a picture or a recording says what it is and what could not be read from it.

interface Shadow {
    readonly content: string;
    readonly deriver: string;
    readonly derivedAt: string;
    readonly title?: string;
    readonly notes: readonly string[];
    readonly stamp: string;
}

const SHADOWS = new Map<string, Shadow>();

const extensionOf = (path: string): string => path.slice(path.lastIndexOf(`.`) + 1).toLowerCase();
const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// What the file is now, by content: a shadow made from something else is stale.
const stampOf = (path: string): string | undefined => {
    const bytes = bytesOf(path);
    if (bytes === undefined) {
        return undefined;
    }
    let hash = 0x81_1c_9d_c5;
    for (const byte of bytes) {
        hash = Math.imul(hash ^ byte, 0x01_00_01_93) >>> 0;
    }
    return `${bytes.length}:${hash.toString(16)}`;
};

const DOCUMENTS = new Set([`docx`]);
const PICTURES = new Set([`png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`]);
const RECORDINGS = new Set([`wav`, `mp3`, `m4a`, `mp4`, `webm`, `mov`]);
const ARCHIVES = new Set([`zip`, `tar`, `gz`, `tgz`]);
const READABLE = new Set([...DOCUMENTS, ...PICTURES, ...RECORDINGS, ...ARCHIVES, `ipynb`, `pdf`, `xlsx`, `pptx`, `odt`, `epub`]);

const derivable = (path: string): boolean => READABLE.has(extensionOf(path));

// The paragraphs of word/document.xml, each a line of markdown; a heading style becomes a heading.
const docxText = (bytes: Uint8Array): { title?: string; content: string } => {
    const xml = new TextDecoder().decode(unzipSync(bytes)[`word/document.xml`] ?? new Uint8Array());
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>(.*?)<\/w:p>/gsu)].map((match) => {
        const body = match[1] ?? ``;
        const text = [...body.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/gu)].map((run) => run[1] ?? ``).join(``);
        return /<w:pStyle w:val="(?:Heading|Title)/u.test(body) ? `# ${text}` : text;
    });
    const content = paragraphs.filter((line) => line.trim() !== ``).join(`\n\n`);
    const title = paragraphs.find((line) => line.startsWith(`# `))?.slice(2);
    return title === undefined ? { content } : { title, content };
};

const render = (path: string): Omit<Shadow, "derivedAt" | "stamp"> | undefined => {
    const extension = extensionOf(path);
    const bytes = bytesOf(path);
    if (DOCUMENTS.has(extension) && bytes !== undefined && bytes[0] === 0x50) {
        return { ...docxText(bytes), deriver: `docx v2`, notes: [] };
    }
    const members = archiveMembers(path);
    if (ARCHIVES.has(extension)) {
        const listed = (members ?? []).map(([member]) => `- \`${member}\``);
        return {
            content: `# ${nameOf(path)}\n\n${listed.length === 0 ? `An archive whose listing could not be read.` : `${listed.length} files:\n\n${listed.join(`\n`)}`}`,
            deriver: `archive v1`,
            notes: listed.length === 0 ? [`the listing was unreadable`] : [],
        };
    }
    if (PICTURES.has(extension)) {
        return {
            content: `# ${nameOf(path)}\n\nA picture. No text was found in it.`,
            deriver: `image+ocr v1`,
            notes: [`recognised rather than read: a picture holds no text of its own`],
        };
    }
    if (RECORDINGS.has(extension)) {
        const seconds = bytes === undefined ? undefined : Math.max(0, (bytes.length - 44) / (22_050 * 2));
        return {
            content: `# ${nameOf(path)}\n\nA recording${seconds === undefined ? `` : ` of ${seconds.toFixed(1)} s`} with no speech in it: two notes of a chime.`,
            deriver: `audio+asr v1`,
            notes: [`transcribed, not read: no words were heard`],
        };
    }
    const text = fileBody(path);
    return text === undefined || !READABLE.has(extension) ? undefined : { content: text, deriver: `text v1`, notes: [] };
};

const present = (path: string, shadow: Shadow, stale: boolean): WorkspaceDerived => {
    const answer: WorkspaceDerived = {
        present: true,
        state: `idle`,
        path,
        content: shadow.content,
        deriver: shadow.deriver,
        derivedAt: shadow.derivedAt,
        notes: [...shadow.notes],
        tokens: Math.ceil(shadow.content.length / 4),
        truncated: false,
        stale,
    };
    if (shadow.title !== undefined) {
        answer.title = shadow.title;
    }
    return answer;
};

/** GET /workspace/derived: what is kept for `path`, never deriving. */
export const readDerived = (path: string): WorkspaceDerived => {
    const shadow = SHADOWS.get(path);
    if (shadow === undefined) {
        return { present: false, state: `idle`, path, derivable: derivable(path) };
    }
    return present(path, shadow, stampOf(path) !== shadow.stamp);
};

/** POST /workspace/derive: renders `path` now, keeps it, and says so to every reader watching. */
export const derive = (path: string): WorkspaceDerived => {
    const stamp = stampOf(path);
    if (stamp === undefined) {
        return { present: false, state: `idle`, path, derivable: false, reason: `there is no file at that path` };
    }
    const rendered = derivable(path) ? render(path) : undefined;
    if (rendered === undefined) {
        return { present: false, state: `undeliverable`, path, derivable: false, reason: `no reader here claims this format` };
    }
    const shadow: Shadow = { ...rendered, derivedAt: new Date().toISOString(), stamp };
    SHADOWS.set(path, shadow);
    pushDerived([path]);
    return present(path, shadow, false);
};
