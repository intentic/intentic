import { homePath } from "@intentic/sandbox-contract/app-routes";
import { ref } from "vue";
import type { RouteLocationNormalized } from "vue-router";

/* The sandbox comes from the address: a route naming one the account lists selects it, the list asked again once before
   a sandbox is called gone; one it does not list is said to be not on the account, and the same page of the sandbox open
   before is shown instead. The address names it by its name and the tail of its id, and any other way of naming it (the
   whole id, a name since changed) is replaced by that. */

const sandboxes = ref<{ id: string; name: string }[]>([]);
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

const BOX = `cmtu1eqyv0001dawma7zi4n3i`;
// The box's address as it is written now: its name's words and the tail of its id.
const BOX_SEGMENT = `my-box-zi4n3i`;
// SAFETY: the gate reads the route's name, params, query and hash only, which these carry.
const at = (name: string, params: Record<string, string>, query: Record<string, string> = {}): RouteLocationNormalized =>
    ({ name, params, query, hash: ``, meta: {} }) as RouteLocationNormalized;

beforeEach(() => {
    sandboxes.value = [
        { id: `before`, name: `Before` },
        { id: BOX, name: `My box` },
    ];
    activeSandboxId.value = `before`;
    for (const mock of [list, refresh, select, report]) {
        mock.mockClear();
    }
});

it(`selects the sandbox a known address names, without asking the platform again`, async () => {
    expect(await selectRouteSandbox(at(`inside:agents`, { sandbox: BOX_SEGMENT }))).toBe(true);

    expect(select).toHaveBeenCalledWith(BOX);
    expect(list).toHaveBeenCalledTimes(0);
});

it(`writes an address naming the sandbox by its whole id, or by a name since changed, as it is written now`, async () => {
    for (const written of [BOX, `old-name-zi4n3i`]) {
        expect(await selectRouteSandbox(at(`inside:agent`, { sandbox: written, id: `a1` }, { view: `changes` }))).toEqual({
            name: `inside:agent`,
            params: { sandbox: BOX_SEGMENT, id: `a1` },
            query: { view: `changes` },
            hash: ``,
        });
    }
    expect(select).toHaveBeenCalledWith(BOX);
});

it(`leaves the selection alone when the address names the sandbox already open`, async () => {
    expect(await selectRouteSandbox(at(`home`, { sandbox: `before` }))).toBe(true);

    expect(select).toHaveBeenCalledTimes(0);
});

it(`asks again past the cache for a sandbox just made elsewhere, and selects it`, async () => {
    sandboxes.value = [{ id: `before`, name: `Before` }];
    refresh.mockImplementationOnce(async () => [
        { id: `before`, name: `Before` },
        { id: `fresh`, name: `Fresh` },
    ]);

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

    expect(await selectRouteSandbox(at(`inside:agents`, { sandbox: BOX_SEGMENT }))).toBe(true);
    expect(await selectRouteSandbox(at(`home`, {}))).toBe(true);
    expect(report).toHaveBeenCalledTimes(0);
});
