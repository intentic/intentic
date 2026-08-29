import type { ExtensionManifest } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import { type ExtensionSection, sectionsOf } from "./extensionCategories";
import type { ExtensionEntry } from "./useExtensionList";

const entry = (name: string, category?: string): ExtensionEntry =>
    ({
        extension: {
            id: `intentic.${name}`,
            manifest: { publisher: `intentic`, name, version: `1.0.0`, category, engines: { intentic: `^1.0.0` } } as ExtensionManifest,
        },
    }) as ExtensionEntry;

const shape = (sections: ExtensionSection[]): [string, string[]][] =>
    sections.map((section) => [section.label, section.entries.map((held) => held.extension.manifest.name)]);

describe(`sectionsOf`, () => {
    it(`renders the sections in their editorial order, not the order the rows arrive in`, () => {
        expect(
            shape(sectionsOf([entry(`logs`, `sandbox`), entry(`knowledge`, `knowledge`), entry(`viewers`, `workspace`), entry(`activity`, `work`)])),
        ).toEqual([
            [`Work & delivery`, [`activity`]],
            [`Workspace`, [`viewers`]],
            [`Knowledge`, [`knowledge`]],
            [`The sandbox`, [`logs`]],
        ]);
    });

    it(`keeps the order rows arrive in WITHIN a section: the list stays alphabetical under its heading`, () => {
        expect(shape(sectionsOf([entry(`acceptance`, `work`), entry(`activity`, `work`), entry(`pipelines`, `work`)]))).toEqual([
            [`Work & delivery`, [`acceptance`, `activity`, `pipelines`]],
        ]);
    });

    it(`omits a section with no rows, so a filter takes the heading with it`, () => {
        expect(shape(sectionsOf([entry(`knowledge`, `knowledge`)]))).toEqual([[`Knowledge`, [`knowledge`]]]);
    });

    it(`lists an extension that declares nothing rather than dropping it: an unrendered row cannot be switched off`, () => {
        expect(shape(sectionsOf([entry(`mystery`)]))).toEqual([[`Other`, [`mystery`]]]);
    });

    it(`lands a third-party section this build has never heard of in Other, and installs it all the same`, () => {
        expect(shape(sectionsOf([entry(`incidents`, `observability`), entry(`knowledge`, `knowledge`)]))).toEqual([
            [`Knowledge`, [`knowledge`]],
            [`Other`, [`incidents`]],
        ]);
    });

    it(`captions only the section whose heading doesn't say why a row is in it`, () => {
        expect(sectionsOf([entry(`knowledge`, `knowledge`), entry(`mystery`)]).map((section) => section.caption)).toEqual([
            undefined,
            undefined,
        ]);
    });
});
