// The card a file tab shows when no file is behind it: what was asked, in whose copy, and what it may have meant, each
// of which opens in the card's place.
import "@intentic/testing/dom";
import { installUi } from "@intentic/ui";
import type { WorkspaceResolve } from "@intentic/sandbox-contract";
import { type App, computed, createApp, h, nextTick } from "vue";

const lookUpWorkspaceRef = jest.fn(async (_path: string, _scope: { agent: string | undefined }): Promise<WorkspaceResolve | undefined> => ({}));
jest.mock("../../features/workspace/files/refs/resolveFileRef", () => ({ lookUpWorkspaceRef }));
jest.mock("../../features/workspace/health/scopeTitle", () => ({ useScopeTitle: () => computed(() => `Intentic bare-metal OS`) }));

const { default: SideFileMissing } = await import("./SideFileMissing.vue");
const { closeAllTabs, useSidePanel } = await import("../../workbench/side/sideTabs");
const { useQuickOpen } = await import("../../workbench/commands/useQuickOpen");

const panel = useSidePanel();

let app: App | undefined;
const mount = async (props: { reference: string; agent?: string; gone?: boolean; nearby?: readonly string[]; line?: number }): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(SideFileMissing, props) });
    installUi(app);
    app.mount(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    return host;
};

const suggestionNames = (host: HTMLElement): string[] => [...host.querySelectorAll(`button[title]`)].map((button) => button.getAttribute(`title`) ?? ``);

beforeEach(() => {
    lookUpWorkspaceRef.mockClear();
    closeAllTabs();
    useQuickOpen().mounted.value = false;
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`says what was asked and in whose copy, and offers what the opener already learned, without asking again`, async () => {
    const host = await mount({ reference: `installer/config.toml`, agent: `crisp-maple-eucl`, nearby: [`intentic/_os/installer/bib-config.toml`] });
    expect(host.textContent).toContain(`config.toml`);
    expect(host.textContent).toContain(`installer/config.toml`);
    expect(host.textContent).toContain(`Intentic bare-metal OS`);
    expect(suggestionNames(host)).toEqual([`intentic/_os/installer/bib-config.toml`]);
    expect(lookUpWorkspaceRef).not.toHaveBeenCalled();
});

it(`opens a picked suggestion in the card's place, in the same copy`, async () => {
    const host = await mount({ reference: `installer/config.toml`, agent: `crisp-maple-eucl`, nearby: [`intentic/_os/installer/bib-config.toml`], line: 7 });
    host.querySelector<HTMLButtonElement>(`button[title]`)?.click();
    await nextTick();
    expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ path: `intentic/_os/installer/bib-config.toml`, agent: `crisp-maple-eucl` }]);
    expect(Object.values(panel.jumps.value)[0]?.line).toBe(7);
});

it(`asks again for a file that went while open, and offers where it is now`, async () => {
    lookUpWorkspaceRef.mockResolvedValue({ path: `_os/installer/bib-config.toml`, renamedFrom: `_os/installer/config.toml` });
    const host = await mount({ reference: `_os/installer/config.toml`, gone: true });
    expect(lookUpWorkspaceRef).toHaveBeenCalledWith(`_os/installer/config.toml`, { agent: undefined });
    expect(suggestionNames(host)).toEqual([`_os/installer/bib-config.toml`]);
});

it(`offers a search only where this window draws the palette`, async () => {
    const without = await mount({ reference: `installer/config.toml`, nearby: [] });
    expect(without.querySelectorAll(`button`)).toHaveLength(0);
    app?.unmount();
    useQuickOpen().mounted.value = true;
    const withPalette = await mount({ reference: `installer/config.toml`, nearby: [] });
    const search = withPalette.querySelector<HTMLButtonElement>(`button`);
    expect(search).not.toBeNull();
    search?.click();
    expect(useQuickOpen().isOpen.value).toBe(true);
    expect(useQuickOpen().seed.value).toBe(`config.toml`);
});
