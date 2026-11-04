import { homePath } from "@intentic/sandbox-contract/app-routes";
import { ref } from "vue";
import type { RouteLocationNormalized } from "vue-router";

/* The sandbox comes from the address: a route naming one the account lists selects it, the list asked again once before
   a sandbox is called gone; one it does not list is said to be not on the account, and the same page of the sandbox open
   before is shown instead. */

const sandboxes = ref<{ id: string }[]>([]);
const activeSandboxId = ref<string | undefined>(`before`);
const list = jest.fn(async () => sandboxes.value);
const refresh = jest.fn(async () => sandboxes.value);
const select = jest.fn((id: string) => {
    activeSandboxId.value = id;
});
jest.mock("../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId, list, refresh, select }) }));
const report = jest.fn();
jest.mock("../workbench/notifications/notifications", () => ({ useNotifications: () => ({ report }) }));

const { selectRouteSandbox } = await import("./shellGates");

const BOX = `a1b2c3d4e5f6`;
// SAFETY: the gate reads the route's name, params, query and hash only, which these carry.
const at = (name: string, params: Record<string, string>, query: Record<string, string> = {}): RouteLocationNormalized =>
    ({ name, params, query, hash: ``, meta: {} }) as RouteLocationNormalized;

beforeEach(() => {
    sandboxes.value = [{ id: `before` }, { id: BOX }];
    activeSandboxId.value = `before`;
    for (const mock of [list, refresh, select, report]) {
        mock.mockClear();
    }
});

it(`selects the sandbox a known address names, without asking the platform again`, async () => {
    expect(await selectRouteSandbox(at(`inside:agents`, { sandbox: BOX }))).toBe(true);

    expect(select).toHaveBeenCalledWith(BOX);
    expect(list).toHaveBeenCalledTimes(0);
});

it(`leaves the selection alone when the address names the sandbox already open`, async () => {
    expect(await selectRouteSandbox(at(`home`, { sandbox: `before` }))).toBe(true);

    expect(select).toHaveBeenCalledTimes(0);
});

it(`asks again past the cache for a sandbox just made elsewhere, and selects it`, async () => {
    sandboxes.value = [{ id: `before` }];
    refresh.mockImplementationOnce(async () => [{ id: `before` }, { id: `fresh` }]);

    expect(await selectRouteSandbox(at(`inside:workspace`, { sandbox: `fresh` }))).toBe(true);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(`fresh`);
});

it(`says a sandbox the account does not list is not on it, and shows the same page of the one open before`, async () => {
    const answer = await selectRouteSandbox(at(`inside:sandboxSettings`, { sandbox: `stranger`, tab: `models` }, { open: `claude` }));

    expect(answer).toEqual({ name: `inside:sandboxSettings`, params: { sandbox: `before`, tab: `models` }, query: { open: `claude` }, hash: `` });
    expect(report).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(0);
});

it(`has only Home to show when no sandbox was open before`, async () => {
    activeSandboxId.value = undefined;

    expect(await selectRouteSandbox(at(`home`, { sandbox: `stranger` }))).toBe(homePath());
});

it(`takes the address as it stands while the platform cannot be asked, and passes an address naming no sandbox`, async () => {
    sandboxes.value = [];
    list.mockImplementationOnce(async () => {
        throw new Error(`offline`);
    });

    expect(await selectRouteSandbox(at(`inside:agents`, { sandbox: BOX }))).toBe(true);
    expect(await selectRouteSandbox(at(`home`, {}))).toBe(true);
    expect(report).toHaveBeenCalledTimes(0);
});
