// Pins the form's Test: what it asks the daemon to dial, that a second press while one is in flight does nothing, that
// the service naming the account renames a name nobody chose, and that "no test exists" retires the button.
import "@intentic/testing/dom";
import type { CapabilityProbe, CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { effectScope, type EffectScope, ref } from "vue";
import * as actualSandboxRpc from "../sandbox/client/sandboxRpc";
import type { ProcedureInput } from "../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

// The one daemon call under test; each case says what it answers.
const probe = jest.fn<(input: ProcedureInput<`capabilities.probe`>) => Promise<CapabilityProbe>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../sandbox/client/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ capabilities: { probe } }) }));

const { useCapabilityForm } = await import("./capabilityForm");
const { useCapabilityProbe } = await import("./capabilityProbe");

const SSH = CAPABILITY_CATALOG.find((entry) => entry.id === `ssh`)!;

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    probe.mockReset();
});

// The Test over a real form on the SSH tile, answered by `answer`.
const testOn = (entry: CapabilityCatalogEntry | undefined, answer: () => Promise<CapabilityProbe>) => {
    probe.mockImplementation(answer);
    const state = {
        selected: ref(entry),
        editing: ref<CapabilitySummary | undefined>(),
        instances: ref<readonly CapabilitySummary[]>([]),
        capabilities: ref<readonly CapabilitySummary[]>([]),
        device: ref(``),
        recommendationFor: (): CapabilityRecommendation | undefined => undefined,
        contributionOf: () => undefined,
        error: ref<NoticeModel | null>(null),
    };
    const scope = effectScope();
    scopes.push(scope);
    return scope.run(() => {
        const form = useCapabilityForm(state);
        return { state, form, test: useCapabilityProbe({ selected: state.selected, form, error: state.error }) };
    })!;
};

describe(`the Test`, () => {
    it(`dials the service with the form's answers under the name it would be saved as, and shows what it said`, async () => {
        const { form, test } = testOn(SSH, async () => ({ checked: true, ok: false, message: `Permission denied (publickey).` }));
        Object.assign(form.values, { host: ` ops.acme.dev `, user: `ada`, privateKey: `KEY` });
        form.name.value = `Ops Box`;

        await test.runProbe();

        expect(probe.mock.calls).toEqual([
            [{ id: `Ops-Box`, kind: `ssh`, config: { host: `ops.acme.dev`, port: `22`, user: `ada`, auth: `key`, privateKey: `KEY` } }],
        ]);
        expect(form.probeResult.value).toEqual({ checked: true, ok: false, message: `Permission denied (publickey).` });
        expect(test.probing.value).toBe(false);
    });

    it(`drops a second press while the first is still out, and clears the last answer as it starts`, async () => {
        let answer: (probe: CapabilityProbe) => void = () => undefined;
        const { form, test } = testOn(SSH, () => new Promise((resolve) => (answer = resolve)));
        form.probeResult.value = { checked: true, ok: false, message: `an older answer` };

        const first = test.runProbe();
        void test.runProbe();
        expect([test.probing.value, probe.mock.calls.length]).toEqual([true, 1]);
        expect(form.probeResult.value).toBeUndefined();

        answer({ checked: true, ok: true, message: `Connected.` });
        await first;
        expect([test.probing.value, form.probeResult.value?.message]).toEqual([false, `Connected.`]);
    });

    it(`renames a name nobody chose after the account the service named`, async () => {
        const { form, test } = testOn(SSH, async () => ({ checked: true, ok: true, message: `Signed in as Ada.`, who: `Ada` }));
        expect(form.name.value).toBe(`ssh`);

        await test.runProbe();

        expect(form.name.value).toBe(`ssh`);
        // The first connection keeps the bare id; the account names the next one.
        const second = testOn(SSH, async () => ({ checked: true, ok: true, message: `Signed in as Ada.`, who: `Ada` }));
        second.state.instances.value = [{ id: `ssh`, kind: `ssh`, status: { state: `active` }, config: {}, secrets: [] }];
        await second.test.runProbe();
        expect(second.form.name.value).toBe(`ssh-ada`);
    });

    it(`goes away once the tile says no test exists for it, and is not offered without a tile`, async () => {
        const { test } = testOn(SSH, async () => ({ checked: false, ok: false, message: `Nothing to test for this connection.` }));
        expect(test.canProbe.value).toBe(true);

        await test.runProbe();
        expect(test.canProbe.value).toBe(false);
        expect(testOn(undefined, async () => ({ checked: true, ok: true, message: `` })).test.canProbe.value).toBe(false);
    });

    it(`says it could not test when the daemon refuses, and is ready to try again`, async () => {
        const { state, test } = testOn(SSH, async () => {
            throw new Error(`sandbox unreachable`);
        });

        await test.runProbe();

        expect(state.error.value).toEqual({ tone: `danger`, title: `Could not test that connection.`, detail: `sandbox unreachable` });
        expect([test.probing.value, test.canProbe.value]).toEqual([false, true]);
    });
});
