// A start or stop on a background process used to hold its row in the surface that pressed it and throw its refusal at
// the click handler, where nothing said it. What is pinned: the press is held for every surface showing the row, and a
// refusal is kept on that row until it is pressed again or put away.
const stops = { answer: undefined as undefined | { resolve: () => void; reject: (error: Error) => void } };

jest.mock("../extensions/useExtensions", () => ({
    useExtensions: () => ({
        extensions: { value: [{ id: `gateway`, manifest: { contributes: { processes: [{ name: `serve` }] } } }] },
    }),
}));
jest.mock("./terminalsQuery", () => ({
    useTerminalsQuery: () => ({
        sessions: { value: [{ name: `ext-gateway-serve`, kind: `process`, extensionId: `gateway`, processName: `serve`, running: true }] },
        refetch: async () => undefined,
    }),
}));
jest.mock("../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        extensions: {
            processStop: () =>
                new Promise((resolve, reject) => {
                    stops.answer = { resolve: () => resolve({ ok: true } as never), reject };
                }),
        },
    }),
}));

import { type EffectScope, effectScope } from "vue";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";
import { forgetOperations } from "../../workbench/operations/operations";
import { useBackgroundProcesses } from "./useBackgroundProcesses";

const mount = (): { view: ReturnType<typeof useBackgroundProcesses>; scope: EffectScope } => {
    const scope = effectScope();
    const view = scope.run(() => useBackgroundProcesses())!;
    return { view, scope };
};

afterEach(() => {
    forgetOperations();
    stops.answer = undefined;
});

it(`holds a row's press for every surface showing it, and keeps its refusal on the row`, async () => {
    const popover = mount();
    const page = mount();
    const row = popover.view.rows.value[0]!;
    expect(row).toMatchObject({ id: `gateway/serve`, running: true });

    const pressed = popover.view.stop(row);
    expect(page.view.pressing(row)).toBe(true);
    expect(page.view.busy.value).toBe(`gateway/serve`);

    stops.answer!.reject(new Error(`The gateway is still draining.`));
    await pressed;
    expect(page.view.pressing(row)).toBe(false);
    expect(popover.view.failure(row)).toMatchObject({ title: `Couldn't stop serve.`, detail: `The gateway is still draining.` });

    popover.view.dismiss(row);
    expect(page.view.failure(row)).toBeUndefined();
    popover.scope.stop();
    page.scope.stop();
});
