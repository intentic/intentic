// Pins how the open sandbox's name and logo reach the sandbox's own copy: a new name the platform gave the open sandbox
// asks it to fetch its copy at once, a switch or a window open without the platform does not, and a window open without
// the platform draws the open row with the name and logo the sandbox keeps.
import type { SandboxSummary } from "@intentic/api-contract";
import type { PresentationRead, PresentationRefresh } from "@intentic/sandbox-contract/schemas/system";
import { QueryClient } from "@tanstack/vue-query";
import { nextTick, ref } from "vue";
import { inSetup } from "../../testing/inSetup";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";
import { sandboxSummary } from "../../testing/sandboxSummary";
import { directMode } from "../directory/directState";
import { startPresentationSync } from "./presentationSync";
import { SANDBOX_LIST_KEY } from "../sandbox/useSandbox";

const KEPT: PresentationRead = { presentation: { name: `Studio`, image: `data:image/png;base64,AAAA`, at: `2026-11-09T10:00:00.000Z` } };

// A started sync over one open sandbox that answers; every daemon route is one the sandbox has.
const started = (open: SandboxSummary, rows: readonly SandboxSummary[] = [open]) => {
    const active = ref<SandboxSummary | undefined>(open);
    const refresh = jest.fn(async (): Promise<PresentationRefresh> => ({ ...KEPT, refreshed: true }));
    const read = jest.fn(async (): Promise<PresentationRead> => KEPT);
    const cache = new QueryClient();
    cache.setQueryData(SANDBOX_LIST_KEY, rows);
    const { stop } = inSetup(() =>
        startPresentationSync({
            active,
            reachable: ref(true),
            rpc: fakeSandboxRpc({ system: { presentationRefresh: refresh, presentation: read } }),
            supports: () => true,
            cache,
        }),
    );
    return { active, refresh, read, cache, stop };
};

// The daemon calls a watcher starts are fire-and-forget; one macrotask lets them settle.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let stopSync: () => void = () => undefined;

afterEach(() => {
    stopSync();
    directMode.value = false;
});

test(`a new name for the open sandbox asks it to fetch its copy, once`, async () => {
    const sync = started(sandboxSummary({ id: `a`, name: `Alpha` }));
    stopSync = sync.stop;

    sync.active.value = sandboxSummary({ id: `a`, name: `Alpha prime` });
    await nextTick();
    await settled();

    expect(sync.refresh).toHaveBeenCalledTimes(1);
    expect(sync.read).not.toHaveBeenCalled();
});

test(`a switch to another sandbox asks nothing, nor does a rename while open without the platform`, async () => {
    const sync = started(sandboxSummary({ id: `a`, name: `Alpha` }));
    stopSync = sync.stop;

    sync.active.value = sandboxSummary({ id: `b`, name: `Beta` });
    await nextTick();
    directMode.value = true;
    sync.active.value = sandboxSummary({ id: `b`, name: `Beta prime` });
    await nextTick();
    await settled();

    expect(sync.refresh).not.toHaveBeenCalled();
});

test(`open without the platform, the open row takes the name and logo the sandbox keeps, and no other row does`, async () => {
    directMode.value = true;
    const open = sandboxSummary({ id: `a`, name: `a.example.com` });
    const other = sandboxSummary({ id: `b`, name: `Beta` });
    const sync = started(open, [open, other]);
    stopSync = sync.stop;
    await settled();

    expect(sync.read).toHaveBeenCalledTimes(1);
    expect(sync.cache.getQueryData(SANDBOX_LIST_KEY)).toEqual([{ ...open, name: `Studio`, image: `data:image/png;base64,AAAA` }, other]);
});
