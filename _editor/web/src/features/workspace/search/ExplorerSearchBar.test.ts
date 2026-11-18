import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { computed, createApp, h, nextTick, ref } from "vue";
import { setDaemonRoutes } from "../../../client/sandbox/useDaemonRoutes";
import { useSearchOptions } from "../../../models/workspace/search/useSearchOptions";
import type { ExplorerSearchBox } from "./useExplorerSearch";

// The one search box every explorer shows, the workspace's and a folder of this computer's: its scopes, and the switches
// each scope brings.

const { default: ExplorerSearchBar } = await import("./ExplorerSearchBar.vue");

const boxIn = (scope: `name` | `text`): ExplorerSearchBox => {
    const filter = ref(``);
    const chosen = ref(scope);
    return {
        filter,
        scope: chosen,
        contentMode: computed(() => chosen.value !== `name`),
        textMode: computed(() => chosen.value === `text`),
        options: useSearchOptions(),
        clear: () => {
            filter.value = ``;
            chosen.value = `name`;
        },
        results: { searching: computed(() => false), pending: computed(() => false) },
    };
};

const mount = async (box: ExplorerSearchBox): Promise<{ el: HTMLElement; unmount: () => void }> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(ExplorerSearchBar, { search: box }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    return {
        el,
        unmount: () => {
            app.unmount();
            el.remove();
        },
    };
};

const labels = (el: HTMLElement): string[] => [...el.querySelectorAll(`[role="radio"], [role="tab"], button`)].map((node) => node.textContent?.trim() ?? ``);

afterEach(() => {
    setDaemonRoutes(undefined);
    localStorage.clear();
});

describe(`ExplorerSearchBar`, () => {
    it(`offers Name and Text in a sandbox, and Text's switches only in Text`, async () => {
        setDaemonRoutes([`workspace.search`], undefined, `sandbox`);
        const box = boxIn(`name`);
        const { el, unmount } = await mount(box);
        expect(labels(el)).toEqual(expect.arrayContaining([`Name`, `Text`]));
        // The meaning search that read the sandbox's index is gone; nothing offers it any more.
        expect(labels(el)).not.toContain(`Smart`);
        expect(labels(el)).not.toContain(`Aa`);
        expect(el.querySelectorAll(`input`)).toHaveLength(1);
        box.scope.value = `text`;
        await nextTick();
        expect(labels(el)).toEqual(expect.arrayContaining([`Aa`, `ab`, `.*`]));
        // Text takes the files to include as well.
        expect(el.querySelectorAll(`input`)).toHaveLength(2);
        unmount();
    });

    it(`offers the same scopes on a folder of this computer`, async () => {
        setDaemonRoutes([`workspace.search`], undefined, `folder`);
        const { el, unmount } = await mount(boxIn(`name`));
        expect(labels(el)).toEqual(expect.arrayContaining([`Name`, `Text`]));
        expect(labels(el)).not.toContain(`Smart`);
        unmount();
    });

    it(`clears the query and goes back to Name on Esc`, async () => {
        const box = boxIn(`text`);
        box.filter.value = `needle`;
        const { el, unmount } = await mount(box);
        el.querySelector(`input`)?.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape` }));
        await nextTick();
        expect([box.filter.value, box.scope.value]).toEqual([``, `name`]);
        unmount();
    });
});
