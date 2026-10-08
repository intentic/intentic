// SPDX-License-Identifier: AGPL-3.0-only
import type { FontSystemWindow } from "./font-system.js";

// The bundle's font catalog answers proprietary family names with redistributable faces (Calibri with Carlito, Andale
// Mono with Liberation Mono, Comic Sans MS with DejaVu Sans), but some of those rows name only the regular face. The
// editor then makes bold and italic by emboldening and slanting the regular face, and those synthesized glyphs come out
// wrong: 6 pt bold Calibri in a table drew oversized letters piled onto each other, and synthesized bold measures wider
// than the real face, so lines break where Word's do not. A row whose regular face is another row's regular face names
// the same typeface, so it takes the styled faces that row has.

// One family of the vendor's catalog (AscFonts.CFontInfo): a file index and a face index per style, the file index -1
// where the catalog has no face for that style.
export interface CatalogFamily {
    indexR: number;
    faceIndexR: number;
    indexI: number;
    faceIndexI: number;
    indexB: number;
    faceIndexB: number;
    indexBI: number;
    faceIndexBI: number;
}

// The styled faces a family can be missing, as its file-index and face-index fields.
const STYLED = [
    [`indexI`, `faceIndexI`],
    [`indexB`, `faceIndexB`],
    [`indexBI`, `faceIndexBI`],
] as const;

const FIELDS = [`indexR`, `faceIndexR`, ...STYLED.flat()] as const;

const isFamily = (value: unknown): value is CatalogFamily => {
    if (typeof value !== `object` || value === null) {
        return false;
    }
    // SAFETY: an object, as checked above; each field is read as unknown and checked to be a number.
    const fields = value as Record<string, unknown>;
    return FIELDS.every((field) => typeof fields[field] === `number`);
};

// Fills every missing styled face of a family from the families that share its regular face, where those agree on the
// face; a face a family already has is never changed. Answers how many faces it filled.
export const completeFamilyFaces = (catalog: readonly unknown[]): number => {
    const byRegular = new Map<string, CatalogFamily[]>();
    for (const family of catalog.filter(isFamily)) {
        if (family.indexR !== -1) {
            const key = `${family.indexR}:${family.faceIndexR}`;
            byRegular.set(key, [...(byRegular.get(key) ?? []), family]);
        }
    }
    let filled = 0;
    for (const siblings of byRegular.values()) {
        for (const [index, faceIndex] of STYLED) {
            const having = siblings.filter((family) => family[index] !== -1);
            const faces = new Set(having.map((family) => `${family[index]}:${family[faceIndex]}`));
            const donor = having[0];
            if (donor === undefined || faces.size !== 1) {
                continue;
            }
            for (const family of siblings) {
                if (family[index] === -1) {
                    family[index] = donor[index];
                    family[faceIndex] = donor[faceIndex];
                    filled += 1;
                }
            }
        }
    }
    return filled;
};

// Catalogs already completed, by the array the vendor built.
const completed = new WeakSet<object>();

// Completes the frame's font catalog once the vendor has built it, before a document asks it for faces; true once done.
export const installFamilyFacesFix = (win: FontSystemWindow): boolean => {
    const catalog = win.AscFonts?.g_font_infos;
    if (!Array.isArray(catalog)) {
        return false;
    }
    if (!completed.has(catalog)) {
        completeFamilyFaces(catalog);
        completed.add(catalog);
    }
    return true;
};
