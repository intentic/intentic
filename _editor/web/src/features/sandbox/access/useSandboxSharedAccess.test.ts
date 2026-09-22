import "@intentic/testing/dom";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, ref } from "vue";
import type { SandboxSummary } from "@intentic/api-contract";

const active = ref<SandboxSummary | undefined>({ id: `sbx-1`, name: `Guest`, image: null, lastSeenAt: null, role: `owner` } as SandboxSummary);
const reachable = ref(true);
mock.module("../client/useSandbox", () => ({ useSandbox: () => ({ active, reachable }) }));

const sandboxJson = mock<(_path: string) => Promise<unknown>>();
mock.module("../client/sandboxClient", () => ({ sandboxJson: (...args: Parameters<typeof sandboxJson>) => sandboxJson(...args) }));

const { queryClient } = await import("../../../lib/queryPersistence");
const { useSandboxSharedAccess } = await import("./useSandboxSharedAccess");

let app: ReturnType<typeof createApp> | undefined;

const mounted = (): ReturnType<typeof useSandboxSharedAccess> => {
    app?.unmount();
    let result!: ReturnType<typeof useSandboxSharedAccess>;
    app = createApp(
        defineComponent({
            setup() {
                result = useSandboxSharedAccess();
                return () => h(`div`);
            },
        }),
    );
    app.use(VueQueryPlugin, { queryClient });
    app.mount(document.createElement(`div`));
    return result;
};

beforeEach(() => {
    // Unmounted and cleared, not reset: reset refetches whatever is still observing, which answered from the previous
    // test's mock and left a read this test then finds fresh (staleTime) and never re-runs.
    app?.unmount();
    app = undefined;
    queryClient.clear();
    active.value = { id: `sbx-1`, name: `Guest`, image: null, lastSeenAt: null, role: `owner` } as SandboxSummary;
    sandboxJson.mockReset();
    sandboxJson.mockResolvedValue({ members: [], owner: `owner@example.com` });
});

describe("useSandboxSharedAccess", () => {
    it("is false for an owner alone on the roster", async () => {
        const { sharedAccess } = mounted();
        await waitFor(() => expect(sharedAccess.value).toBe(false));
    });

    it("is true once the owner has granted someone else access", async () => {
        sandboxJson.mockResolvedValue({
            members: [{ email: `guest@example.com`, role: `collaborator` }],
            owner: `owner@example.com`,
        });
        const { sharedAccess } = mounted();
        await waitFor(() => expect(sharedAccess.value).toBe(true));
    });

    it("is true for a member, since the roster already names someone besides them", () => {
        active.value = { id: `sbx-1`, name: `Guest`, image: null, lastSeenAt: null, role: `collaborator` } as SandboxSummary;
        const { sharedAccess } = mounted();
        expect(sharedAccess.value).toBe(true);
    });
});
