// Who changes a secret's rules, and whom they can name to release it. Whoever runs secrets changes them: the owner, Full
// access, or someone given Secrets (sandbox-contract `holdsRight`), and anybody else reads them. The roster that lists
// everyone to name is People and access's, so somebody given Secrets alone is not sent asking for it: they are offered
// themselves and the names already on a gate, enough to name oneself and to take somebody off.
import { type ManageRight, holdsRight, type MembersRoster } from "@intentic/sandbox-contract/schemas/members";
import type { CredentialGate } from "@intentic/sandbox-contract/schemas/secrets";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import * as vueQueryOriginal from "@tanstack/vue-query";
import { computed, ref } from "vue";

const caller = ref<{ role: MemberRole; manages?: ManageRight[] }>({ role: `owner` });
const roster = ref<MembersRoster | undefined>(undefined);
const gates = ref<CredentialGate[]>([]);
const reader = ref<string | undefined>(`owner@x.com`);
// Whether each roster read was allowed to ask, in the order the hook asked.
const asked: boolean[] = [];

jest.mock(`@tanstack/vue-query`, () => ({
    ...vueQueryOriginal,
    useQueryClient: () => ({ invalidateQueries: async () => undefined }),
    useMutation: () => ({}),
}));
jest.mock(`../../client/sandbox/access/useAccess`, () => ({ useAccess: () => ({ holds: (right: ManageRight) => holdsRight(caller.value, right) }) }));
jest.mock(`../../client/sandbox/useMembers`, () => ({
    useMembers: (options: { enabled: { value: boolean } }) => {
        asked.push(options.enabled.value);
        return { roster: computed(() => (options.enabled.value ? roster.value : undefined)) };
    },
}));
jest.mock(`../../client/sandbox/useSandboxQuery`, () => ({ useSandboxQuery: () => ({ query: { data: computed(() => ({ gates: gates.value })) } }) }));
jest.mock(`../../client/session/sandboxSession`, () => ({ useSandboxSession: () => ({ presentedEmail: reader }) }));
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: {} }));

const { approverChoicesOf, useCredentialGates } = await import("./useSecrets");

const GATE: CredentialGate = { subject: `DATABASE_URL`, kind: `secret`, approvers: [`Owner@x.com`, `carol@x.com`], scope: `use` };
const ROSTER: MembersRoster = {
    owner: `owner@x.com`,
    members: [
        { email: `bob@x.com`, role: `maintainer` },
        { email: `helper@x.com`, role: `collaborator`, manages: [`secrets`] },
    ],
};

beforeEach(() => {
    caller.value = { role: `owner` };
    roster.value = ROSTER;
    gates.value = [];
    reader.value = `owner@x.com`;
    asked.length = 0;
});

describe(`approverChoicesOf`, () => {
    it(`lists the owner, the roster, the reader and every name a gate holds, each once whatever its letter case`, () => {
        expect(approverChoicesOf(ROSTER, `helper@x.com`, [GATE])).toEqual([`owner@x.com`, `bob@x.com`, `helper@x.com`, `carol@x.com`]);
    });

    it(`offers the reader and the names on a gate when there is no roster to read`, () => {
        expect(approverChoicesOf(undefined, `helper@x.com`, [GATE])).toEqual([`helper@x.com`, `Owner@x.com`, `carol@x.com`]);
        expect(approverChoicesOf(undefined, undefined, [])).toEqual([]);
    });
});

describe(`useCredentialGates`, () => {
    it(`lets the owner change the rules and name anybody on the roster`, () => {
        const gate = useCredentialGates();
        expect(gate.runsSecrets.value).toBe(true);
        expect(gate.namesEveryone.value).toBe(true);
        expect(asked).toEqual([true]);
        expect(gate.approverChoices.value).toEqual([`owner@x.com`, `bob@x.com`, `helper@x.com`]);
    });

    it(`lets Full access do the same`, () => {
        caller.value = { role: `maintainer` };
        reader.value = `bob@x.com`;
        const gate = useCredentialGates();
        expect(gate.runsSecrets.value).toBe(true);
        expect(gate.namesEveryone.value).toBe(true);
    });

    it(`lets someone given Secrets change the rules, offering themselves and the names already on a gate, never asking for the roster`, () => {
        caller.value = { role: `collaborator`, manages: [`secrets`] };
        reader.value = `Helper@X.com`;
        gates.value = [GATE];
        const gate = useCredentialGates();
        expect(gate.runsSecrets.value).toBe(true);
        expect(gate.namesEveryone.value).toBe(false);
        expect(asked).toEqual([false]);
        expect(gate.approverChoices.value).toEqual([`helper@x.com`, `Owner@x.com`, `carol@x.com`]);
    });

    it(`leaves a plain collaborator, and someone given only the privacy shield, reading the rules`, () => {
        caller.value = { role: `collaborator` };
        expect(useCredentialGates().runsSecrets.value).toBe(false);
        caller.value = { role: `collaborator`, manages: [`privacy`] };
        expect(useCredentialGates().runsSecrets.value).toBe(false);
    });

    it(`follows a right given or taken while the page is open`, () => {
        caller.value = { role: `collaborator` };
        const gate = useCredentialGates();
        expect(gate.runsSecrets.value).toBe(false);
        caller.value = { role: `collaborator`, manages: [`secrets`, `people`] };
        expect(gate.runsSecrets.value).toBe(true);
        expect(gate.namesEveryone.value).toBe(true);
    });
});
