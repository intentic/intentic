import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { kindLabel, PEEK_LINES, peekLines, peekPlan } from "./peekContent";

const file = (name: string, size?: number): WorkspaceTreeEntry => ({
    name,
    path: `dir/${name}`,
    type: `file`,
    ...(size === undefined ? {} : { size }),
});
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `dir`, children: [] });

describe(`what a hover can show`, () => {
    it(`lists a folder`, () => {
        expect(peekPlan(dir(`src`))).toEqual({ kind: `folder` });
    });

    it(`reads text with its grammar, or plain where none is known`, () => {
        expect(peekPlan(file(`index.ts`))).toEqual({ kind: `text`, lang: `typescript` });
        expect(peekPlan(file(`README.md`))).toEqual({ kind: `text`, lang: `markdown` });
        expect(peekPlan(file(`NOTES`))).toEqual({ kind: `text` });
    });

    it(`paints a picture the browser can draw`, () => {
        expect(peekPlan(file(`logo.png`))).toEqual({ kind: `picture` });
        expect(peekPlan(file(`icon.svg`))).toEqual({ kind: `picture` });
    });

    it(`plays a video`, () => {
        expect(peekPlan(file(`intro.mp4`))).toEqual({ kind: `video` });
        expect(peekPlan(file(`clip.webm`))).toEqual({ kind: `video` });
    });

    it(`draws a document as its own pages`, () => {
        expect(peekPlan(file(`brief.docx`, 40_000))).toEqual({ kind: `document` });
        expect(peekPlan(file(`notes.odt`, 40_000))).toEqual({ kind: `document` });
        expect(peekPlan(file(`memo.rtf`, 40_000))).toEqual({ kind: `document` });
    });

    it(`leaves a document too big to parse under the pointer`, () => {
        expect(peekPlan(file(`thesis.docx`, 40 * 1024 * 1024))).toEqual({ kind: `none` });
    });

    it(`shows nothing of bytes it cannot read`, () => {
        expect(peekPlan(file(`report.pdf`))).toEqual({ kind: `none` });
        expect(peekPlan(file(`site.zip`))).toEqual({ kind: `none` });
        expect(peekPlan(file(`raw.psd`))).toEqual({ kind: `none` });
        expect(peekPlan(file(`empty.png`, 0))).toEqual({ kind: `none` });
    });
});

describe(`what an entry is called`, () => {
    it(`uses the name people use for the common extensions`, () => {
        expect(kindLabel(file(`app.ts`))).toBe(`TypeScript`);
        expect(kindLabel(file(`App.vue`))).toBe(`Vue component`);
        expect(kindLabel(file(`shot.png`))).toBe(`PNG picture`);
        expect(kindLabel(file(`pnpm-lock.yaml`))).toBe(`YAML`);
    });

    it(`falls back to the kind's own word`, () => {
        expect(kindLabel(file(`main.zig`))).toBe(`File`);
        expect(kindLabel(file(`Dockerfile`))).toBe(`Config`);
        expect(kindLabel(dir(`src`))).toBe(`Folder`);
    });
});

describe(`the lines the card shows`, () => {
    it(`keeps the first lines of a whole file`, () => {
        expect(peekLines(`a\nb\nc`, 5, 5)).toBe(`a\nb\nc`);
    });

    it(`drops a line the window cut mid-way`, () => {
        expect(peekLines(`a\nb\nc`, 5, 40)).toBe(`a\nb`);
    });

    it(`stops at the card's line budget`, () => {
        const many = Array.from({ length: 40 }, (_, index) => `line ${index}`).join(`\n`);
        expect(peekLines(many, many.length, many.length).split(`\n`)).toHaveLength(PEEK_LINES);
    });
});
