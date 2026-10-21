// Pins when "the live app" can be picked: once the apps have answered. The public outbox's files only join the pick; a
// failed outbox read once held the palette's "Go to: Live app" and the status bar's chip silently doing nothing.
import type { Loaded } from "@intentic/extension-api";
import { ref } from "vue";

const panelsRead = ref<Loaded<unknown>>({ state: `waiting`, since: 0, retry: undefined });
const publicRead = ref<Loaded<unknown>>({ state: `waiting`, since: 0, retry: undefined });

jest.mock(`@tanstack/vue-query`, () => ({ useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
jest.mock(`../../models/extensions/usePanels`, () => ({
    usePanels: () => ({ panels: ref([]), loaded: panelsRead, start: async () => undefined, stop: async () => undefined, invalidate: async () => undefined }),
}));
jest.mock(`../../models/workspace/push/usePublicOutbox`, () => ({ usePublicOutbox: () => ({ files: ref([]), loaded: publicRead }) }));
jest.mock(`../../models/sandbox/environment/usePorts`, () => ({ usePorts: () => ({ offered: ref([]) }) }));
jest.mock(`../../client/sandbox/useSandboxQuery`, () => ({ useSandboxQuery: () => ({ query: { data: ref(undefined) } }) }));
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: {} }));
jest.mock(`../../models/fleet/useAgents-actions`, () => ({ stopJob: async () => undefined }));

const { usePreviewTargets } = await import("./usePreviewTargets");

const READY: Loaded<unknown> = { state: `ready`, data: [], refreshing: false, refreshError: undefined };

test(`picks once the apps have answered, whether or not the outbox read could be made`, () => {
    const { pickable } = usePreviewTargets(ref(true));
    expect(pickable.value).toBe(false);

    panelsRead.value = READY;
    expect(pickable.value).toBe(false);

    publicRead.value = { state: `failed`, error: `Not found`, retry: undefined };
    expect(pickable.value).toBe(true);

    publicRead.value = READY;
    expect(pickable.value).toBe(true);
});

test(`picks nothing while the apps themselves could not be read`, () => {
    panelsRead.value = { state: `failed`, error: `Unreachable`, retry: undefined };
    publicRead.value = READY;
    const { pickable } = usePreviewTargets(ref(true));

    expect(pickable.value).toBe(false);
});
