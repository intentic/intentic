import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { byNaturalName, homeGroups, homeOrder, groupOf, labelsShown } from "./homeOrder";

const file = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `file` });
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `dir`, children: [] });

const keys = (entries: readonly WorkspaceTreeEntry[]): string[] => homeGroups(entries).map((group) => group.key);
const names = (entries: readonly WorkspaceTreeEntry[]): string[] => homeOrder(homeGroups(entries)).map((entry) => entry.name);

describe(`which group a home entry lands in`, () => {
    it(`seats a folder apart from every file`, () => {
        expect(groupOf(dir(`src`))).toBe(`folders`);
        expect(groupOf(dir(`README.md`))).toBe(`folders`);
    });

    it(`reads a file's kind, not its extension`, () => {
        expect(groupOf(file(`index.ts`))).toBe(`code`);
        expect(groupOf(file(`App.vue`))).toBe(`code`);
        expect(groupOf(file(`deploy.sh`))).toBe(`code`);
        expect(groupOf(file(`theme.css`))).toBe(`styles`);
        expect(groupOf(file(`schema.prisma`))).toBe(`data`);
        expect(groupOf(file(`package.json`))).toBe(`config`);
        expect(groupOf(file(`pnpm-lock.yaml`))).toBe(`config`);
        expect(groupOf(file(`README.md`))).toBe(`documents`);
        expect(groupOf(file(`Spec.docx`))).toBe(`documents`);
        expect(groupOf(file(`report.pdf`))).toBe(`documents`);
        expect(groupOf(file(`deck.pptx`))).toBe(`documents`);
        expect(groupOf(file(`book.epub`))).toBe(`documents`);
        expect(groupOf(file(`sheet.xlsx`))).toBe(`data`);
        expect(groupOf(file(`rows.csv`))).toBe(`data`);
        expect(groupOf(file(`logo.png`))).toBe(`pictures`);
        expect(groupOf(file(`site.zip`))).toBe(`archives`);
        expect(groupOf(file(`app.jar`))).toBe(`archives`);
        expect(groupOf(file(`Inter.woff2`))).toBe(`other`);
        expect(groupOf(file(`LICENSE`))).toBe(`other`);
    });

    it(`seats video with sound, which the tree's own categories do not know`, () => {
        expect(groupOf(file(`intro.mp4`))).toBe(`media`);
        expect(groupOf(file(`voice.mp3`))).toBe(`media`);
    });
});

describe(`the order a folder reads in`, () => {
    it(`runs folders, then kinds in reading order, leaving empty kinds out`, () => {
        expect(keys([file(`a.ts`), file(`b.css`), dir(`src`), file(`c.md`), file(`d.zip`), file(`e.png`)])).toEqual([
            `folders`,
            `documents`,
            `pictures`,
            `code`,
            `styles`,
            `archives`,
        ]);
    });

    it(`sorts names naturally inside each group, case-blind and numeric-aware`, () => {
        expect(names([file(`img10.png`), file(`img2.png`), file(`Img1.png`)])).toEqual([`Img1.png`, `img2.png`, `img10.png`]);
        expect(names([file(`readme.md`), file(`Notes.md`), file(`about.md`)])).toEqual([`about.md`, `Notes.md`, `readme.md`]);
    });

    it(`keeps a test beside its subject, which extension grouping would split`, () => {
        expect(names([file(`useLayout.ts`), file(`Button.vue`), file(`Button.test.ts`), file(`useLayout.test.ts`)])).toEqual([
            `Button.test.ts`,
            `Button.vue`,
            `useLayout.test.ts`,
            `useLayout.ts`,
        ]);
    });

    it(`gives two names the collator calls equal one fixed order`, () => {
        const pair = [file(`readme.md`), file(`README.md`)];
        expect(pair.toSorted(byNaturalName).map((entry) => entry.name)).toEqual(
            pair
                .toReversed()
                .toSorted(byNaturalName)
                .map((entry) => entry.name),
        );
    });
});

describe(`when group labels are drawn`, () => {
    it(`shows none for a folder of one kind`, () => {
        expect(labelsShown(homeGroups([file(`a.ts`), file(`b.ts`)]))).toBe(false);
        expect(labelsShown(homeGroups([]))).toBe(false);
    });

    it(`shows them once there is a second kind to tell apart, folders included`, () => {
        expect(labelsShown(homeGroups([dir(`src`), file(`a.ts`)]))).toBe(true);
        expect(labelsShown(homeGroups([file(`a.ts`), file(`a.css`)]))).toBe(true);
    });
});
