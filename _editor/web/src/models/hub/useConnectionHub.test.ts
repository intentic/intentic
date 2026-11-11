import type { HubSave, HubSaved, HubState, HubTake, HubTaken } from "@intentic/sandbox-contract/schemas/connection-hub";
import { nextTick, type Ref, ref, shallowRef } from "vue";
import { inSetup } from "../../testing/inSetup";
import { forgetOperations } from "../../workbench/operations/operations";
import { type HubWire, useConnectionHub } from "./useConnectionHub";

// The hub's two presses as a surface drives them: a save sends one card or account to the computer named and reads the
// hub again, so its row says how it went; a take asks the computers, and only a take that made something here reads the
// cards and accounts again. Each press is kept by what it was about, and a refusal stays with it.

const STATE: HubState = {
    computers: [
        { machine: `rog`, online: true, setUp: true, locked: false },
        { machine: `omen`, online: false, setUp: true },
    ],
    holdings: [
        { target: { type: `card`, id: `github` }, label: `github`, want: { type: `card`, kind: `cli`, connector: `github` } },
        { target: { type: `card`, id: `linear` }, label: `linear`, reason: `It is a sign-in this sandbox renews.` },
    ],
    failures: [],
};

const GITHUB = { type: `card`, id: `github` } as const;
const LINEAR = { type: `card`, id: `linear` } as const;
const CURSOR = { type: `account`, provider: `cursor` } as const;

const wireWith = (answers: { save?: (input: HubSave) => Promise<HubSaved>; take?: (input: HubTake) => Promise<HubTaken> }) => {
    const data = shallowRef<HubState | undefined>(STATE);
    const reads: boolean[] = [];
    const polling = shallowRef<Readonly<Ref<boolean>>>();
    const saved: HubSave[] = [];
    const taken: HubTake[] = [];
    const calls = { reads, polling, hubChanged: 0, connectionsChanged: 0, saved, taken };
    const wire: HubWire = {
        read: (enabled, poll) => {
            calls.reads.push(enabled.value);
            polling.value = poll;
            return { data };
        },
        save: async (input) => {
            calls.saved.push(input);
            return (answers.save ?? (async () => ({ entry: `CONNECTION_GITHUB_AB12`, machine: input.machine, pending: false })))(input);
        },
        take: async (input) => {
            calls.taken.push(input);
            return (answers.take ?? (async () => ({ outcome: `none`, message: `Nothing saved there answers it.` })))(input);
        },
        hubChanged: async () => {
            calls.hubChanged += 1;
        },
        connectionsChanged: async () => {
            calls.connectionsChanged += 1;
        },
    };
    return { wire, calls, data };
};

const stops: (() => void)[] = [];
const hubOn = (wire: HubWire, relevant = ref(true)) => {
    const { result, stop } = inSetup(() => useConnectionHub(relevant, wire));
    stops.push(stop);
    return result;
};

afterEach(() => {
    for (const stop of stops.splice(0)) {
        stop();
    }
    forgetOperations();
});

describe(`reading the hub`, () => {
    it(`offers a connection that can travel to the computers that can take one, and nothing to one that cannot`, () => {
        const hub = hubOn(wireWith({}).wire);

        expect(hub.offered.value).toBe(true);
        expect(hub.rowOf(GITHUB)).toEqual({ saveTo: [`rog`], note: undefined, busy: false });
        expect(hub.rowOf(LINEAR).saveTo).toEqual([]);
    });

    it(`asks nothing, and offers nothing, on a surface that does not offer the hub`, () => {
        const { wire, calls } = wireWith({});
        const hub = hubOn(wire, ref(false));

        expect(calls.reads).toEqual([false]);
        expect(hub.offered.value).toBe(false);
        expect(hub.rowOf(GITHUB).saveTo).toEqual([]);
    });
});

describe(`saving`, () => {
    it(`sends the card to the computer named, then reads the hub again`, async () => {
        const { wire, calls } = wireWith({});
        const hub = hubOn(wire);

        await hub.save(GITHUB, `rog`);
        expect(calls.saved).toEqual([{ target: GITHUB, machine: `rog` }]);
        expect(calls.hubChanged).toBe(1);
        expect(calls.connectionsChanged).toBe(0);
        expect(hub.rowOf(GITHUB).busy).toBe(false);
        expect(hub.saveFailure([GITHUB])).toBeUndefined();
    });

    it(`keeps a refusal with the connection it was about, until that connection is saved again`, async () => {
        let refuse = true;
        const { wire } = wireWith({
            save: async (input) => {
                if (refuse) {
                    throw new Error(`rog did not take it: declined at the computer`);
                }
                return { entry: `CONNECTION_GITHUB_AB12`, machine: input.machine, pending: true };
            },
        });
        const hub = hubOn(wire);

        await hub.save(GITHUB, `rog`);
        expect(hub.saveFailure([GITHUB])).toMatchObject({ tone: `danger`, title: `Couldn't save it to rog.` });
        expect(hub.saveFailure([LINEAR])).toBeUndefined();

        refuse = false;
        await hub.save(GITHUB, `rog`);
        expect(hub.saveFailure([GITHUB])).toBeUndefined();

        refuse = true;
        await hub.save(GITHUB, `rog`);
        hub.dismissSaves([GITHUB]);
        expect(hub.saveFailure([GITHUB])).toBeUndefined();
    });

    it(`does not send a second save of one connection while the first is on its way`, async () => {
        let answer: (saved: HubSaved) => void = () => undefined;
        const { wire, calls } = wireWith({ save: () => new Promise((resolve) => (answer = resolve)) });
        const hub = hubOn(wire);

        const first = hub.save(GITHUB, `rog`);
        await Promise.resolve();
        // Its row says where it is going while it goes.
        expect(hub.rowOf(GITHUB)).toMatchObject({ busy: true, note: `Saving to rog` });
        await hub.save(GITHUB, `rog`);
        answer({ entry: `CONNECTION_GITHUB_AB12`, machine: `rog`, pending: false });
        await first;
        expect(calls.saved).toHaveLength(1);
    });
});

describe(`taking`, () => {
    it(`reads the cards and accounts again once the computer shared one and it was made here`, async () => {
        const { wire, calls } = wireWith({ take: async () => ({ outcome: `taken`, message: `Shared from rog.`, target: { type: `account`, provider: `cursor`, id: `cur_1` } }) });
        const hub = hubOn(wire);

        await hub.take(CURSOR);
        expect(calls.taken).toEqual([{ want: CURSOR }]);
        expect(calls.connectionsChanged).toBe(1);
        expect(hub.takeOf(CURSOR)).toMatchObject({ busy: false, answer: { outcome: `taken`, message: `Shared from rog.` } });
    });

    it(`says the computer's answer when it waits for a yes there, and reads only the hub again`, async () => {
        const { wire, calls } = wireWith({ take: async () => ({ outcome: `waiting`, message: `Waiting for your yes in Passwords on rog.` }) });
        const hub = hubOn(wire);

        expect(calls.polling.value?.value).toBe(false);
        await hub.take(CURSOR);
        expect(calls.connectionsChanged).toBe(0);
        expect(calls.hubChanged).toBe(1);
        expect(hub.takeOf(CURSOR).answer?.message).toBe(`Waiting for your yes in Passwords on rog.`);
        // Another provider's panel has asked nothing, so it has nothing to say.
        expect(hub.takeOf({ type: `account`, provider: `devin` }).answer).toBeUndefined();
    });

    it(`keeps reading the hub while a take waits, and reads the lists again once the yes made something here`, async () => {
        const { wire, calls, data } = wireWith({ take: async () => ({ outcome: `waiting`, message: `Waiting for your yes in Passwords on rog.` }) });
        const hub = hubOn(wire);

        await hub.take(CURSOR);
        expect(calls.polling.value?.value).toBe(true);

        // The person said yes at rog: the next read lists a Cursor account made from the entry it shared.
        const made = { target: { type: `account`, provider: `cursor`, id: `cur_1` }, label: `Cursor Pro`, from: { entry: `CONNECTION_CURSOR_19B2`, machine: `rog` } } as const;
        data.value = { ...STATE, holdings: [...STATE.holdings, made] };
        await nextTick();
        expect(calls.connectionsChanged).toBe(1);
    });

    it(`keeps a refusal as the take's own, in its words`, async () => {
        const { wire } = wireWith({
            take: async () => {
                throw new Error(`Passwords is not set up on rog yet.`);
            },
        });
        const hub = hubOn(wire);

        await hub.take(CURSOR);
        expect(hub.takeOf(CURSOR)).toMatchObject({ busy: false, answer: undefined, failure: { title: `Couldn't ask your computer for it.` } });
        hub.dismissTake(CURSOR);
        expect(hub.takeOf(CURSOR).failure).toBeUndefined();
    });
});
