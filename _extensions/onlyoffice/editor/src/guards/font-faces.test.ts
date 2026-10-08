// SPDX-License-Identifier: AGPL-3.0-only
import { completeFamilyFaces, installFamilyFacesFix, type CatalogFamily } from "./font-faces.js";

// The catalog completion against rows shaped like the bundle's own AllFonts.js: an alias that names only its
// substitute's regular face takes that substitute's styled faces, and nothing else in the catalog moves.

// A row as AllFonts.js writes it: name, then file and face index for regular, italic, bold and bold italic.
const row = (name: string, ...faces: number[]): CatalogFamily & { Name: string } => {
    const [indexR = -1, faceIndexR = -1, indexI = -1, faceIndexI = -1, indexB = -1, faceIndexB = -1, indexBI = -1, faceIndexBI = -1] = faces;
    return { Name: name, indexR, faceIndexR, indexI, faceIndexI, indexB, faceIndexB, indexBI, faceIndexBI };
};

const faces = (family: CatalogFamily): number[] => [
    family.indexR,
    family.faceIndexR,
    family.indexI,
    family.faceIndexI,
    family.indexB,
    family.faceIndexB,
    family.indexBI,
    family.faceIndexBI,
];

describe(`completeFamilyFaces`, () => {
    it(`gives an alias that names only a regular face the styled faces of the family that owns it`, () => {
        const calibri = row(`Calibri`, 115, 0, -1, -1, -1, -1, -1, -1);
        const carlito = row(`Carlito`, 115, 0, 114, 0, 112, 0, 113, 0);
        expect(completeFamilyFaces([calibri, carlito])).toBe(3);
        expect(faces(calibri)).toEqual([115, 0, 114, 0, 112, 0, 113, 0]);
        expect(faces(carlito)).toEqual([115, 0, 114, 0, 112, 0, 113, 0]);
    });

    it(`fills only the faces a family lacks, never one it has`, () => {
        const comic = row(`Comic Sans MS`, 51, 0, -1, -1, 50, 0, -1, -1);
        const dejavu = row(`DejaVu Sans`, 51, 0, 119, 0, 50, 0, 117, 0);
        const verdana = row(`Verdana`, 51, 0, 119, 0, 50, 0, 117, 0);
        expect(completeFamilyFaces([comic, dejavu, verdana])).toBe(2);
        expect(faces(comic)).toEqual([51, 0, 119, 0, 50, 0, 117, 0]);
    });

    it(`leaves a family alone when no other shares its regular face`, () => {
        const arialBlack = row(`Arial Black`, 62, 0, -1, -1, -1, -1, -1, -1);
        const arial = row(`Arial`, 65, 0, 64, 0, 62, 0, 63, 0);
        expect(completeFamilyFaces([arialBlack, arial])).toBe(0);
        expect(faces(arialBlack)).toEqual([62, 0, -1, -1, -1, -1, -1, -1]);
    });

    it(`tells faces of one file apart by their face index`, () => {
        const ukaiCn = row(`AR PL UKai CN`, 106, 0);
        const ukaiTw = row(`AR PL UKai TW`, 106, 2, -1, -1, 107, 0);
        expect(completeFamilyFaces([ukaiCn, ukaiTw])).toBe(0);
        expect(faces(ukaiCn)).toEqual([106, 0, -1, -1, -1, -1, -1, -1]);
    });

    it(`fills nothing where the families sharing a regular face disagree on a style`, () => {
        const alias = row(`Alias`, 10, 0);
        const one = row(`One`, 10, 0, -1, -1, 11, 0);
        const other = row(`Other`, 10, 0, -1, -1, 12, 0);
        expect(completeFamilyFaces([alias, one, other])).toBe(0);
        expect(alias.indexB).toBe(-1);
    });

    it(`skips the holes and foreign entries a vendor array can hold`, () => {
        const calibri = row(`Calibri`, 115, 0);
        const carlito = row(`Carlito`, 115, 0, 114, 0, 112, 0, 113, 0);
        expect(completeFamilyFaces([undefined, null, { Name: `odd` }, calibri, carlito])).toBe(3);
        expect(calibri.indexB).toBe(112);
    });
});

describe(`installFamilyFacesFix`, () => {
    it(`waits for the catalog, then completes it once`, () => {
        const win: { AscFonts?: { g_font_infos?: unknown } } = {};
        expect(installFamilyFacesFix(win)).toBe(false);
        const calibri = row(`Calibri`, 115, 0);
        const carlito = row(`Carlito`, 115, 0, 114, 0, 112, 0, 113, 0);
        win.AscFonts = { g_font_infos: [calibri, carlito] };
        expect(installFamilyFacesFix(win)).toBe(true);
        expect(calibri.indexBI).toBe(113);
        // A second pass over the same catalog leaves a face set after the first one as it is.
        calibri.indexBI = 7;
        expect(installFamilyFacesFix(win)).toBe(true);
        expect(calibri.indexBI).toBe(7);
    });
});
