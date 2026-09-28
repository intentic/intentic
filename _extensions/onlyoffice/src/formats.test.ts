import { documentTypeOf, extensionOf, OFFICE_FORMATS, READ_ONLY_IN_BROWSER } from "./formats.js";
import { manifest } from "./manifest.js";

describe(`office formats`, () => {
    it(`claims in the manifest exactly the formats the table knows an editor for`, () => {
        const claimed = manifest.contributes?.viewers?.find((viewer) => viewer.id === `office`)?.extensions ?? [];
        expect([...claimed].toSorted()).toEqual(Object.values(OFFICE_FORMATS).flat().toSorted());
    });

    it(`is the editing viewer, fed the path alone`, () => {
        const viewer = manifest.contributes?.viewers?.find((entry) => entry.id === `office`);
        expect(viewer).toMatchObject({ edit: true, fetch: `path` });
    });

    it(`maps an extension to its editor, and a stranger to nothing`, () => {
        expect(documentTypeOf(`docx`)).toBe(`word`);
        expect(documentTypeOf(`ods`)).toBe(`cell`);
        expect(documentTypeOf(`ppt`)).toBe(`slide`);
        expect(documentTypeOf(`pdf`)).toBeUndefined();
        expect(documentTypeOf(``)).toBeUndefined();
    });

    it(`opens view-only in the browser only formats the table claims, and only the legacy binary ones`, () => {
        expect(READ_ONLY_IN_BROWSER).toEqual([`doc`, `xls`, `ppt`]);
        expect(READ_ONLY_IN_BROWSER.every((extension) => documentTypeOf(extension) !== undefined)).toBe(true);
    });

    it(`reads the extension the way the host's resolver does: lowercased, none for a dotfile`, () => {
        expect(extensionOf(`docs/Brief.DOCX`)).toBe(`docx`);
        expect(extensionOf(`.gitignore`)).toBe(``);
        expect(extensionOf(`Makefile`)).toBe(``);
    });
});
