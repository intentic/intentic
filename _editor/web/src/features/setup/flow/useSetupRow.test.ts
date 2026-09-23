import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import { describe, expect, it, mock } from "bun:test";
import { effectScope, nextTick, ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { type SetupRowHost, useSetupRow } from "./useSetupRow";

// Pins the row this visit sets up: created under the next free name once at a time, failing into a notice rather than a
// throw, a check-in baseline that follows the row, a connection that selects before entering, and a draft discarded
// only while this visit minted it and nothing committed it.

const stage = (existing: readonly SandboxSummary[] = []) => {
    const sandbox = {
        sandboxes: ref<SandboxSummary[]>([...existing]),
        create: mock(async (name: string) => sandboxSummary({ id: `new`, name })),
        select: mock((_id: string) => undefined),
        remove: mock(async (_id: string) => undefined),
    } satisfies SetupRowHost[`sandbox`];
    const enter = mock(async () => undefined);
    const row = effectScope().run(() => useSetupRow({ sandbox, enter }))!;
    return { sandbox, enter, row };
};

describe(`the row this visit sets up`, () => {
    it(`creates one under the next free name, as a draft of this visit`, async () => {
        const { sandbox, row } = stage([sandboxSummary({ id: `s1`, name: `workspace` })]);
        await row.autoCreate();
        expect(sandbox.create.mock.calls).toEqual([[`workspace-2`]]);
        expect(row.created.value?.id).toBe(`new`);
        expect([row.createdHere.value, row.creating.value]).toEqual([true, false]);
    });

    it(`creates only once while a create is in flight`, async () => {
        const { sandbox, row } = stage();
        const first = row.autoCreate();
        await row.autoCreate();
        await first;
        expect(sandbox.create).toHaveBeenCalledTimes(1);
    });

    it(`says why a create failed, and leaves no draft behind`, async () => {
        const { sandbox, row } = stage();
        sandbox.create.mockRejectedValueOnce(new Error(`quota reached`));
        await row.autoCreate();
        expect(row.error.value).toEqual({ tone: `danger`, title: `Could not create your sandbox.`, detail: `quota reached` });
        expect({ created: row.created.value, createdHere: row.createdHere.value }).toEqual({ created: null, createdHere: false });
    });

    it(`dates check-ins from the row's last boot whenever the row changes`, async () => {
        const { row } = stage();
        expect(row.baseline.value).toBe(null);
        row.created.value = sandboxSummary({ id: `s2`, lastSeenAt: `2026-09-23T10:00:00Z` });
        await nextTick();
        expect(row.baseline.value).toBe(`2026-09-23T10:00:00Z`);
    });

    it(`selects the row it connected before opening the workspace`, async () => {
        const { sandbox, enter, row } = stage();
        await row.connected(`s1`, { attached: true });
        expect(sandbox.select.mock.calls).toEqual([[`s1`]]);
        expect(enter).toHaveBeenCalledTimes(1);
        expect(row.finished.value).toBe(true);
    });
});

describe(`a draft`, () => {
    it(`is discarded, with its platform row, when this visit minted it and nothing committed it`, async () => {
        const { sandbox, row } = stage();
        await row.autoCreate();
        row.discardDraft(false);
        expect(sandbox.remove.mock.calls).toEqual([[`new`]]);
        expect({ created: row.created.value, createdHere: row.createdHere.value }).toEqual({ created: null, createdHere: false });
    });

    it(`is kept once committed, and a resumed row is never one`, async () => {
        const { sandbox, row } = stage();
        await row.autoCreate();
        row.discardDraft(true);
        row.created.value = sandboxSummary({ id: `s1` });
        row.createdHere.value = false;
        row.discardDraft(false);
        expect(sandbox.remove).not.toHaveBeenCalled();
    });

    it(`swallows a failed delete, since whoever discards it is already leaving`, async () => {
        const { sandbox, row } = stage();
        sandbox.remove.mockRejectedValueOnce(new Error(`offline`));
        await row.autoCreate();
        row.discardDraft(false);
        await nextTick();
        expect(sandbox.remove).toHaveBeenCalledTimes(1);
    });
});

describe(`walking away`, () => {
    it(`forgets what the old machine said about itself`, () => {
        const { row } = stage();
        const said = () => ({ boot: row.bootReport.value, refusal: row.announceRefusal.value, announced: row.announced.value });
        row.bootReport.value = { reach: `reachable`, at: `2026-09-23T10:00:00Z` };
        row.announceRefusal.value = { announced: `old.example.dev`, expected: `new.example.dev` };
        row.announced.value = true;
        row.forgetBoot();
        expect(said()).toEqual({ boot: null, refusal: null, announced: false });
    });

    it(`forgets the row, its notice and its claim for another`, () => {
        const { row } = stage();
        const held = () => ({ created: row.created.value, resuming: row.resuming.value, error: row.error.value, claimedAt: row.claimedAt.value });
        row.created.value = sandboxSummary({ id: `s1` });
        row.resuming.value = true;
        row.error.value = { tone: `danger`, title: `nope` };
        row.claimedAt.value = `2026-09-23T10:00:00Z`;
        row.forget();
        expect(held()).toEqual({ created: null, resuming: false, error: null, claimedAt: null });
    });
});
