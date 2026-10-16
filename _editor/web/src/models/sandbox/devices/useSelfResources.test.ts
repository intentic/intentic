// RESHAPING THE SANDBOX SERVING THIS PAGE, FROM EITHER OF ITS TWO DOORS. The Overview card and the chat's memory notice
// both reach it, and the reshape takes this sandbox down for a minute; what is pinned is that it is one run for the
// sandbox, not one per surface: the other door holds its button, either one opened again finds it still going, and a
// refusal is said wherever the reader looks next.
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import { type EffectScope, effectScope, ref } from "vue";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import type { DeviceSandboxPayload } from "./useDevices";

const devices = ref<Device[]>([]);
// The machine's answer, held back by the test so a reshape can be left mid-flight while surfaces come and go.
let answer: Promise<string> = Promise.resolve(`done`);
const sent: { hostId: string; slug: string; op: string; payload: DeviceSandboxPayload | undefined }[] = [];
jest.mock(`./useDevices`, () => ({
    useDevices: () => ({ devices, refetch: () => {} }),
    manageDeviceSandbox: (hostId: string, slug: string, op: string, payload?: DeviceSandboxPayload) => {
        sent.push({ hostId, slug, op, payload });
        return answer;
    },
}));
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        active: ref({ id: `sbx-1`, name: `box` }),
        daemonUrl: ref(`https://box.example.dev`),
    }),
}));

const { useSelfResources } = await import("./useSelfResources");
const { forgetOperations } = await import("../../../workbench/operations/operations");
const { forgetRestarts, restartExpected } = await import("../live/sandboxRestart");

const SHAPE = { memoryGib: 20, cpus: null, privileged: false, gpu: false };

const mount = <V>(setup: () => V): { view: V; scope: EffectScope } => {
    const scope = effectScope();
    const view = scope.run(setup) as V;
    return { view, scope };
};

const sandboxBefore = activeSandboxId.value;

beforeEach(() => {
    activeSandboxId.value = `sbx-1`;
    sent.length = 0;
    devices.value = [
        {
            key: `omen`,
            label: `omen`,
            hostId: `omen`,
            online: true,
            facts: { features: [`set-shape`] },
            sandboxes: [
                {
                    slug: `box`,
                    running: true,
                    resources: { memoryBytes: 16 * 1024 ** 3, cpus: 4, privileged: false, gpu: false, hostRuntime: [], overlayRuntime: [] },
                },
            ],
        } as unknown as Device,
    ];
});

afterEach(() => {
    forgetOperations();
    forgetRestarts();
    activeSandboxId.value = sandboxBefore;
});

it(`holds the other surface's button, and the reopened one's, while a reshape runs`, async () => {
    let finish: (said: string) => void = () => {};
    answer = new Promise<string>((resolve) => (finish = resolve));
    const overview = mount(() => useSelfResources());
    const chat = mount(() => useSelfResources());
    const applied = overview.view.apply(SHAPE);
    expect(chat.view.applying.value).toBe(true);

    overview.scope.stop();
    const back = mount(() => useSelfResources());
    expect(back.view.applying.value).toBe(true);
    // A second press while it runs sends nothing.
    await back.view.apply(SHAPE);
    expect(sent).toHaveLength(1);

    finish(`restarting`);
    await applied;
    expect(back.view.applying.value).toBe(false);
    chat.scope.stop();
    back.scope.stop();
});

it(`says the silence an apply causes is the reshape, until the sandbox answers again`, async () => {
    answer = Promise.resolve(`restarting`);
    const view = mount(() => useSelfResources());
    await view.view.apply(SHAPE);
    expect(sent[0]?.payload?.severing).toBe(true);
    expect(restartExpected(`sbx-1`)?.untilAnswered).toBe(true);
    view.scope.stop();
});

it(`keeps a refusal for the surface that did not send it, and expects no restart`, async () => {
    answer = Promise.reject(new Error(`ic refused: memory above the engine`));
    const overview = mount(() => useSelfResources());
    const chat = mount(() => useSelfResources());
    await overview.view.apply(SHAPE);
    expect(chat.view.failure.value?.detail).toBe(`ic refused: memory above the engine`);
    expect(restartExpected(`sbx-1`)).toBeUndefined();
    overview.scope.stop();
    chat.scope.stop();
});
