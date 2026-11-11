// The waiting credentials are read only from a daemon that serves the route: one from before it (the released 1.409.0
// named it `secrets.passwordNeeds`) is not asked at all, so the page draws no list and the daemon answers no 404.
import type { SandboxNeed } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { type ComputedRef, ref } from "vue";
import { setDaemonRoutes } from "../../../client/sandbox/useDaemonRoutes";

const NEED: SandboxNeed = { id: `n1`, origin: { kind: `site`, host: `registry.npmjs.org` }, detail: `Publish the release`, machine: `rog`, state: `pending`, at: 1 };

let enabled: ComputedRef<boolean> | undefined;
const data = ref<{ needs: SandboxNeed[] } | undefined>({ needs: [NEED] });
jest.mock(`../../../client/sandbox/useSandboxQuery`, () => ({
    useSandboxQuery: (options: { enabled: ComputedRef<boolean> }) => {
        enabled = options.enabled;
        return { query: { data } };
    },
}));

const { useWants } = await import("./useWants");

afterEach(() => {
    setDaemonRoutes(undefined);
});

test("a daemon that advertises the route is asked, and its waiting credentials are drawn", () => {
    setDaemonRoutes([`secrets.wants`]);
    const { needs } = useWants();

    expect(enabled?.value).toBe(true);
    expect(needs.value).toEqual([NEED]);
});

test("a daemon that has not said what it serves is asked, as every route is until it says", () => {
    const { needs } = useWants();

    expect(enabled?.value).toBe(true);
    expect(needs.value).toEqual([NEED]);
});

test("a daemon from before the route is never asked, and draws nothing", () => {
    setDaemonRoutes([`secrets.passwordNeeds`]);
    const { needs } = useWants();

    expect(enabled?.value).toBe(false);
    expect(needs.value).toEqual([]);
});

test("a reader the page does not ask for is never asked, whatever the daemon serves", () => {
    setDaemonRoutes([`secrets.wants`]);
    const { needs } = useWants(false);

    expect(enabled?.value).toBe(false);
    expect(needs.value).toEqual([]);
});
