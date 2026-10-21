// Pins where the capability list stands for each member: below maintainer the sandbox floors the read, so its answer is
// known without asking (none), and the rail and extension pages that wait on it settle instead of waiting forever.
import type { Loaded } from "@intentic/extension-api";
import { computed, ref } from "vue";

const role = ref(`owner`);
const asked: { enabled?: { value: boolean } }[] = [];
const read = ref<Loaded<unknown>>({ state: `failed`, error: `Forbidden`, retry: undefined });

jest.mock(`@tanstack/vue-query`, () => ({
    useQueryClient: () => ({ invalidateQueries: async () => undefined }),
    useMutation: () => ({}),
}));
jest.mock(`../../client/sandbox/useRole`, () => ({ useRole: () => ({ canShip: computed(() => role.value === `owner` || role.value === `maintainer`) }) }));
jest.mock(`../../client/sandbox/useSandboxQuery`, () => ({
    useSandboxQuery: (options: { enabled?: { value: boolean } }) => {
        asked.push(options);
        return { query: { data: ref(undefined), isLoading: ref(false), refetch: async () => undefined }, error: ref(undefined), loaded: read };
    },
}));
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: {} }));

const { useCapabilities } = await import("./useCapabilities");

beforeEach(() => {
    asked.length = 0;
});

test(`a member below maintainer never asks, and reads the list as answered with nothing in it`, () => {
    role.value = `writer`;
    const { loaded, capabilities } = useCapabilities();

    expect(asked.at(-1)?.enabled?.value).toBe(false);
    expect(loaded.value).toMatchObject({ state: `ready`, data: { capabilities: [] } });
    expect(capabilities.value).toEqual([]);
});

test(`a maintainer reads the list as the sandbox answers it, a failure included`, () => {
    role.value = `maintainer`;
    const { loaded } = useCapabilities();

    expect(asked.at(-1)?.enabled?.value).toBe(true);
    expect(loaded.value).toEqual({ state: `failed`, error: `Forbidden`, retry: undefined });
});
