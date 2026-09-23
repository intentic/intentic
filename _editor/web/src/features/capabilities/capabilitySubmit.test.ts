// Pins the form's submit: what a saved form does next (hand over a pending step, stay on an edit, leave an add), that a
// second press while a write is in flight does nothing, the install's own terminal, and the wallet's second write to
// the platform, whose refusal is said rather than swallowed.
import "@intentic/testing/dom";
import type { CapabilityRecommendation, CapabilityStatus, CapabilitySummary } from "@intentic/api-contract";
import { type AddCapabilityInput, CAPABILITY_CATALOG, type CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { effectScope, type EffectScope, ref } from "vue";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import * as actualWalletPolicy from "./model/walletPolicy";

// The platform's half of a wallet save; every other tile is one write, to the daemon.
const pushWalletPolicy = mock<(config: Readonly<Record<string, string>>) => Promise<void>>(async () => {});
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realWalletPolicy = { ...actualWalletPolicy };
mock.module(`./model/walletPolicy`, () => ({ ...realWalletPolicy, pushWalletPolicy }));

const { useCapabilityForm } = await import("./capabilityForm");
const { submitOutcome, useCapabilitySubmit } = await import("./capabilitySubmit");

const catalogEntry = (id: string): CapabilityCatalogEntry => CAPABILITY_CATALOG.find((entry) => entry.id === id)!;
const SSH = catalogEntry(`ssh`);
const WALLET = catalogEntry(`wallet`);
const connection = (id: string, kind: CapabilitySummary[`kind`], config: Record<string, string>, status: CapabilityStatus): CapabilitySummary => ({
    id,
    kind,
    status,
    config,
    secrets: [],
});

describe(`what a saved form does next`, () => {
    const pending = connection(`ops`, `ssh`, {}, { state: `pending` });
    const active = connection(`ops`, `ssh`, {}, { state: `active` });
    const cases: [CapabilitySummary | undefined, boolean, ReturnType<typeof submitOutcome>][] = [
        [pending, false, { kind: `hand-off`, added: pending, startOver: true }],
        [pending, true, { kind: `hand-off`, added: pending, startOver: false }],
        [active, true, { kind: `close-edit` }],
        [active, false, { kind: `leave` }],
        [undefined, false, { kind: `leave` }],
        [undefined, true, { kind: `close-edit` }],
    ];
    for (const [added, wasEditing, outcome] of cases) {
        it(`${outcome.kind} after ${added?.status.state ?? `nothing listed`}, ${wasEditing ? `editing` : `adding`}`, () => {
            expect(submitOutcome(added, wasEditing)).toEqual(outcome);
        });
    }
});

const scopes: EffectScope[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    pushWalletPolicy.mockClear();
});

// The submit over a real form, with the daemon's streamed apply as `add`: it lists the connection with `status`.
const submitOn = (entry: CapabilityCatalogEntry, status: CapabilityStatus, editing?: CapabilitySummary) => {
    const capabilities = ref<readonly CapabilitySummary[]>(editing === undefined ? [] : [editing]);
    const add = mock(async (input: AddCapabilityInput, onLine?: (line: Record<string, unknown>) => void) => {
        onLine?.({ kind: `terminal`, session: `install-${input.id}` });
        capabilities.value = [
            ...capabilities.value.filter((listed) => listed.id !== input.id),
            connection(input.id, input.kind, input.config, status),
        ];
    });
    const state = {
        selected: ref<CapabilityCatalogEntry | undefined>(entry),
        editing: ref(editing),
        instances: capabilities,
        capabilities,
        device: ref(``),
        recommendationFor: (): CapabilityRecommendation | undefined => undefined,
        contributionOf: () => undefined,
        error: ref<NoticeModel | null>(null),
    };
    const hands = {
        walk: { onwardFrom: mock<(from: CapabilityCatalogEntry) => string | undefined>(() => `docker`), leaveTile: mock() },
        handOff: mock(),
        stopEditing: mock(),
    };
    const scope = effectScope();
    scopes.push(scope);
    return scope.run(() => {
        const form = useCapabilityForm(state);
        const { submit, submitting } = useCapabilitySubmit({ ...state, form, add, ...hands });
        return { state, form, add, submit, submitting, ...hands };
    })!;
};

describe(`a press of submit`, () => {
    it(`refuses a form that cannot go, showing why, and writes nothing`, async () => {
        const { form, add, submit, submitting, state } = submitOn(SSH, { state: `active` });

        await submit();

        expect([add.mock.calls.length, form.attempted.value, submitting.value, state.error.value]).toEqual([0, true, false, null]);
    });

    it(`writes once however often it is pressed while the write is in flight`, async () => {
        const { form, add, submit, submitting } = submitOn(SSH, { state: `active` });
        Object.assign(form.values, { host: `ops.acme.dev`, user: `ada`, privateKey: `KEY` });
        let land: () => void = () => undefined;
        add.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));

        const first = submit();
        void submit();
        expect([add.mock.calls.length, submitting.value]).toEqual([1, true]);

        land();
        await first;
        expect(submitting.value).toBe(false);
    });
});

describe(`an add`, () => {
    it(`sends the form under the name it would be saved as, opens the install's terminal, and moves on to the walk's next tile`, async () => {
        const { form, add, submit, walk, handOff } = submitOn(SSH, { state: `active` });
        Object.assign(form.values, { host: ` ops.acme.dev `, user: `ada`, privateKey: `KEY` });
        form.name.value = `Ops Box`;

        await submit();

        expect(add.mock.calls[0]?.[0]).toEqual({
            id: `Ops-Box`,
            kind: `ssh`,
            config: { host: `ops.acme.dev`, port: `22`, user: `ada`, auth: `key`, privateKey: `KEY` },
        });
        expect(useTerminalPanel().requested.value).toEqual({ name: `install-Ops-Box` });
        // Where the walk goes was decided against the queue before the add took the tile out of it.
        expect([walk.onwardFrom.mock.calls, walk.leaveTile.mock.calls, handOff.mock.calls]).toEqual([[[SSH]], [[`docker`]], []]);
        expect(pushWalletPolicy).toHaveBeenCalledTimes(0);
    });

    it(`stays on the tile when the connection is still pending, hands the step over, and starts over on the next free name`, async () => {
        const { form, submit, walk, handOff, state } = submitOn(SSH, { state: `pending`, detail: `waiting for the host key` });
        Object.assign(form.values, { host: `ops.acme.dev`, user: `ada`, privateKey: `KEY` });

        await submit();

        expect(handOff.mock.calls).toEqual([[SSH, state.capabilities.value[0]]]);
        expect([form.name.value, { ...form.values }, walk.leaveTile.mock.calls]).toEqual([`ssh-2`, {}, []]);
    });

    it(`says the add failed, in the daemon's words, and stays where it was`, async () => {
        const { form, add, submit, walk, state } = submitOn(SSH, { state: `active` });
        Object.assign(form.values, { host: `ops.acme.dev`, user: `ada`, privateKey: `KEY` });
        add.mockRejectedValueOnce(new Error(`host key verification failed`));

        await submit();

        expect(state.error.value).toEqual({ tone: `danger`, title: `Could not add the capability.`, detail: `host key verification failed` });
        expect(walk.leaveTile.mock.calls).toEqual([]);
    });
});

describe(`an edit`, () => {
    const ops = connection(`ops`, `ssh`, { host: `ops.acme.dev`, port: `22`, user: `ada`, auth: `key` }, { state: `active` });

    it(`saves over the same connection and stays on the tile so its row can be checked`, async () => {
        const { add, submit, stopEditing, walk } = submitOn(SSH, { state: `active` }, { ...ops, secrets: [`privateKey`] });

        await submit();

        expect(add.mock.calls[0]?.[0].id).toBe(`ops`);
        expect([stopEditing.mock.calls.length, walk.leaveTile.mock.calls]).toEqual([1, []]);
    });

    it(`keeps its own name when the saved connection is pending`, async () => {
        const { form, submit, handOff, stopEditing } = submitOn(SSH, { state: `pending` }, { ...ops, secrets: [`privateKey`] });

        await submit();

        expect([handOff.mock.calls.length, stopEditing.mock.calls.length, form.name.value]).toEqual([1, 0, `ops`]);
    });

    it(`says the save failed in an edit's words`, async () => {
        const { add, submit, state } = submitOn(SSH, { state: `active` }, { ...ops, secrets: [`privateKey`] });
        add.mockRejectedValueOnce(new Error(`refused`));

        await submit();

        expect(state.error.value).toEqual({ tone: `danger`, title: `Could not save that connection.`, detail: `refused` });
    });
});

describe(`the wallet`, () => {
    it(`hands its caps to the platform as a second write`, async () => {
        const { submit, walk } = submitOn(WALLET, { state: `active` });

        await submit();

        expect(pushWalletPolicy.mock.calls).toEqual([
            [{ network: `eip155:8453`, perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00`, autoApproveUnderUsd: `0` }],
        ]);
        expect(walk.leaveTile.mock.calls).toEqual([[`docker`]]);
    });

    it(`says the signer still enforces the old caps when the platform refuses them, and stays`, async () => {
        const { submit, walk, state } = submitOn(WALLET, { state: `active` });
        pushWalletPolicy.mockRejectedValueOnce(new Error(`policy service unavailable`));

        await submit();

        expect(state.error.value).toEqual({
            tone: `danger`,
            title: `The tile was saved, but the platform did not take its spending caps, so the signer still enforces the previous ones. Save the tile again to retry.`,
            detail: `policy service unavailable`,
        });
        expect(walk.leaveTile.mock.calls).toEqual([]);
    });
});
