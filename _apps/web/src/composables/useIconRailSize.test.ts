// @vitest-environment jsdom
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const load = () => import("./useIconRailSize");

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
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
