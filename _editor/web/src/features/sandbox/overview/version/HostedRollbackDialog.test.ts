// A hosted sandbox going back to the version it ran before its last update: the platform's doing, so it works with the
// sandbox down. What the press must leave behind is the expectation of a restart (every surface reads the silence that
// follows by it), and a refusal must take that expectation back and say why where the press was made.
import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { sandboxSummary } from "../../../../testing/sandboxSummary";

const hostedRollback = jest.fn(async (_input: { sandboxId: string }): Promise<{ ok: boolean }> => ({ ok: true }));
jest.mock(`../../../../lib/useApi`, () => ({ apiClient: { sandbox: { hostedRollback } } }));
const refresh = jest.fn(async (): Promise<SandboxSummary[]> => []);
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ refresh }) }));

const { forgetRestarts, restartExpected } = await import("../../live/sandboxRestart");
const { default: HostedRollbackDialog } = await import("./HostedRollbackDialog.vue");

const hosted = sandboxSummary({ id: `sb1`, name: `acme-shop`, hosted: { region: `ams`, warm: true, canRollBack: true } });

// PrimeVue's Dialog teleports to the body, so everything is queried there rather than under the mount.
const mount = () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    let closed = 0;
    const app = createApp({ render: () => h(HostedRollbackDialog, { sandbox: hosted, onClose: () => (closed += 1) }) });
    app.component(`Icon`, IconStub);
    app.use(PrimeVue);
    app.mount(el);
    return { closed: () => closed };
};

const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

const confirm = async (): Promise<void> => {
    const button = [...document.body.querySelectorAll(`button`)].find((node) => node.textContent?.trim() === `Roll back`);
    button?.click();
    await settle();
};

afterEach(() => {
    forgetRestarts();
    hostedRollback.mockClear();
    refresh.mockClear();
    document.body.innerHTML = ``;
});

it(`asks the platform, not the sandbox, and leaves the restart it causes expected until the sandbox answers`, async () => {
    const dialog = mount();
    await nextTick();
    expect(document.body.textContent).toContain(`Roll acme-shop back?`);
    expect(document.body.textContent).toContain(`Its files and conversations stay.`);
    await confirm();
    expect(hostedRollback).toHaveBeenCalledWith({ sandboxId: `sb1` });
    expect(restartExpected(`sb1`)?.untilAnswered).toBe(true);
    expect(dialog.closed()).toBe(1);
    // The row says whether anything is left to go back to; it is read again rather than guessed.
    expect(refresh).toHaveBeenCalledTimes(1);
});

it(`says a refusal where it was pressed and takes the expected restart back`, async () => {
    hostedRollback.mockRejectedValueOnce(new Error(`No earlier image is kept for this machine.`));
    const dialog = mount();
    await nextTick();
    await confirm();
    expect(document.body.textContent).toContain(`Couldn't roll this sandbox back.`);
    expect(document.body.textContent).toContain(`No earlier image is kept for this machine.`);
    expect(restartExpected(`sb1`)).toBeUndefined();
    expect(dialog.closed()).toBe(0);
});
