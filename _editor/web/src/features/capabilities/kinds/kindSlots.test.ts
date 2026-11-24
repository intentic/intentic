// Pins the editor's per-kind UI registry: every kind has an entry, and the kinds bearing each slot are the ones the
// page, the form, the row and a need's card branched on by name before the registry, so moving a branch into a slot
// moved no kind in or out of it.
import { PEER_KINDS } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import { type CapabilityKind, CapabilityKindSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { KIND_SLOTS, type KindSlots, slotsOf } from "./kindSlots";

const bearing = (slot: keyof KindSlots): CapabilityKind[] =>
    CapabilityKindSchema.options.filter((kind) => slotsOf(kind)[slot] !== undefined);

it(`has an entry for every kind, in the enum's order, and none for a kind that is not one`, () => {
    expect(Object.keys(KIND_SLOTS)).toEqual(CapabilityKindSchema.options);
    expect(slotsOf(undefined)).toEqual({});
});

it(`gives each slot to the kinds that branched on it by name`, () => {
    expect(
        Object.fromEntries(
            (
                [
                    `headerExtra`,
                    `liveLinks`,
                    `pairing`,
                    `signsInByCommand`,
                    `formLead`,
                    `addLead`,
                    `formExtra`,
                    `addsByItself`,
                    `needLead`,
                    `inlineInNeed`,
                    `answersSummary`,
                    `refuseSave`,
                    `beforeSave`,
                    `afterSave`,
                ] as const
            ).map((slot) => [slot, bearing(slot)]),
        ),
    ).toEqual({
        headerExtra: [`extension`],
        liveLinks: [`vpn`, `netdisk`],
        pairing: [`device`, `webext`, `phone`],
        signsInByCommand: [`agent`],
        formLead: [`vpn`, `fleet`],
        addLead: [`plugin`, `link`],
        formExtra: [`docker`, `device`],
        addsByItself: [`fleet`, `link`],
        needLead: [`fleet`, `link`],
        inlineInNeed: [`mcp`, `cli`, `ssh`, `endpoint`, `fleet`],
        answersSummary: [`localmodel`, `wallet`],
        refuseSave: [`wallet`],
        beforeSave: [`docker`],
        afterSave: [`wallet`],
    });
});

it(`pairs exactly the peer kinds, each live-link kind through its own link, and only a computer follows a new name`, () => {
    expect(bearing(`pairing`)).toEqual([...PEER_KINDS]);
    expect([KIND_SLOTS.vpn.liveLinks, KIND_SLOTS.netdisk.liveLinks]).toEqual([`vpn`, `netdisk`]);
    expect(PEER_KINDS.filter((kind) => slotsOf(kind).pairing?.renames === true)).toEqual([`device`]);
});

// Only the kinds whose answers add up to something non-obvious get a sentence under the form, and it is theirs.
it(`says the sentence a tile's answers add up to, for the kinds that have one`, () => {
    const wallet = { perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00`, autoApproveUnderUsd: `0` };
    const model = { model: `unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf`, context: `65536` };

    expect(slotsOf(`wallet`).answersSummary?.(wallet)).toBe(`Every payment asks you in chat first · at most $1.00 each · $5.00 a day.`);
    expect(slotsOf(`localmodel`).answersSummary?.(model)).toBe(`≈ 5.3 GB weights + 4 GB window: needs 9.3 GB of free RAM.`);
    expect(slotsOf(`vpn`).answersSummary?.(wallet)).toBeUndefined();
});

it(`refuses a member's wallet save before any write, and asks the host only for a GPU`, async () => {
    const preflight = jest.fn(async () => ({ checked: true, ok: false, message: `no GPU here` }));
    const context = { hosted: false, ownsSandbox: false, preflight, capture: jest.fn() };

    expect(slotsOf(`wallet`).refuseSave?.(context)).toMatchObject({ tone: `warning` });
    expect(slotsOf(`wallet`).refuseSave?.({ ...context, ownsSandbox: true })).toBeUndefined();
    expect(slotsOf(`docker`).beforeSave?.({ id: `docker`, kind: `docker`, config: { gpu: `off` } }, context)).toBeUndefined();
    await expect(slotsOf(`docker`).beforeSave?.({ id: `docker`, kind: `docker`, config: { gpu: `on` } }, context)).rejects.toThrow(`no GPU here`);
    expect(context.capture).toHaveBeenCalledWith(`gpu_capability_blocked`, { hosted: false });
});
