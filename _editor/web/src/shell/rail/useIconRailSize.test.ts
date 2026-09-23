import "@intentic/testing/dom";
import { nextTick } from "vue";
import { freshImport } from "@intentic/testing/bun";

// The preference is read once, at module scope, so each case needs its own evaluation of the module.
const load = () => freshImport<typeof import("./useIconRailSize")>("./useIconRailSize", import.meta.url);

beforeEach(() => {
    localStorage.clear();
});

describe(`useIconRailSize`, () => {
    it(`defaults to compact`, async () => {
        const { useIconRailSize } = await load();

        expect(useIconRailSize().iconRailSize.value).toBe(`compact`);
    });

    it(`restores the comfortable size`, async () => {
        localStorage.setItem(`ui-icon-rail-size`, `comfortable`);
        const { useIconRailSize } = await load();

        expect(useIconRailSize().iconRailSize.value).toBe(`comfortable`);
    });

    it(`ignores an invalid stored size`, async () => {
        localStorage.setItem(`ui-icon-rail-size`, `wide`);
        const { useIconRailSize } = await load();

        expect(useIconRailSize().iconRailSize.value).toBe(`compact`);
    });

    it(`persists changes`, async () => {
        const { useIconRailSize } = await load();

        useIconRailSize().iconRailSize.value = `comfortable`;
        await nextTick();

        expect(localStorage.getItem(`ui-icon-rail-size`)).toBe(`comfortable`);
    });
});
