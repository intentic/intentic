import { expect, it, vi } from "vitest";

vi.mock("@intentic/ui/async", () => ({
    useAsyncAction: () => ({
        busy: { value: false },
        notice: { value: undefined },
        run: vi.fn(),
    }),
}));
vi.mock("../queryPersistence", () => ({ queryClient: { fetchQuery: vi.fn() }, UNPERSISTED: `unpersisted` }));
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/useSandboxQuery", () => ({
    useSandboxQuery: () => ({
        query: {
            data: { value: undefined },
            isFetching: { value: false },
            refetch: vi.fn(),
        },
        error: { value: undefined },
    }),
}));
vi.mock("./agentActions", () => ({
    askAgentToResolve: vi.fn(),
    discardAgent: vi.fn(),
    invalidateAgentAction: vi.fn(),
    landAgent: vi.fn(),
}));
vi.mock("./useAgents", () => ({ useAgents: () => ({ archive: vi.fn(), setAutoLand: vi.fn() }) }));

import { ref } from "vue";
import { useAgentChanges } from "./useAgentChanges";

it("isolates viewed files when agent ids name object prototype properties", () => {
    const prototype = useAgentChanges(ref(`__proto__`));
    const constructor = useAgentChanges(ref(`constructor`));

    prototype.setViewed([`root/src/prototype.ts`], true);
    expect([...prototype.viewed.value]).toEqual([`root/src/prototype.ts`]);
    expect([...constructor.viewed.value]).toEqual([]);

    constructor.setViewed([`root/src/constructor.ts`], true);
    prototype.setViewed([`root/src/prototype.ts`], false);

    expect([...prototype.viewed.value]).toEqual([]);
    expect([...constructor.viewed.value]).toEqual([`root/src/constructor.ts`]);
});
