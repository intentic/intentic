import { computed, ref } from "vue";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { MemberSelf } from "@intentic/sandbox-contract/schemas/members";

// What the signed-in person may do, asked of the daemon's own check against the real contract: the same answer the
// daemon would give, before anything is sent, and nothing at all until their tier is known.

const platformRole = ref<MemberRole | undefined>(undefined);
const daemonSays = ref<MemberSelf | undefined>(undefined);
jest.mock(`../../useSandbox`, () => ({
    useSandbox: () => ({
        active: computed(() => (platformRole.value === undefined ? undefined : { id: `s1`, role: platformRole.value })),
        refresh: async () => [],
    }),
}));
jest.mock(`../../useMembers`, () => ({ selfMember: () => computed(() => daemonSays.value) }));

const { useAccess } = await import(`../useAccess`);
const { forecastRefusal } = await import(`../forecast`);
const { loadContract } = await import(`../../daemon/contract`);
await loadContract();

const access = useAccess();

beforeEach(() => {
    platformRole.value = undefined;
    daemonSays.value = undefined;
});

describe(`useAccess`, () => {
    it(`knows nothing, and refuses nothing, until the person's tier is known`, () => {
        expect(access.known.value).toBe(false);
        expect(access.refusal(`capabilities.list`)).toBeUndefined();
        expect(access.can(`agents.list`)).toBe(false);
    });

    it(`answers a viewer by each route's floor`, () => {
        platformRole.value = `viewer`;
        expect(access.known.value).toBe(true);
        expect(access.refusal(`capabilities.list`)).toEqual({ kind: `tier`, floor: `maintainer` });
        expect(access.refusal(`capabilities.marketplace`)).toEqual({ kind: `tier`, floor: `maintainer` });
        expect(access.refusal(`agent.reply`)).toEqual({ kind: `tier`, floor: `collaborator` });
        expect(access.refusal(`GET /members/self`)).toBeUndefined();
        expect(access.can(`agents.list`)).toBe(true);
    });

    it(`reads a raw route by its key and a path parameter from what it is given`, () => {
        platformRole.value = `collaborator`;
        expect(access.refusal(`GET /members`)).toEqual({ kind: `tier`, floor: `maintainer` });
        expect(access.refusal(`agents.land`, { id: `abc` })).toEqual({ kind: `tier`, floor: `maintainer` });
        expect(access.can(`agents.requestLand`, { id: `abc` })).toBe(true);
    });

    it(`keeps a guest to its own list, whatever a route's floor`, () => {
        platformRole.value = `guest`;
        expect(access.refusal(`capabilities.list`)).toEqual({ kind: `guest` });
        expect(access.refusal(`git.changes`)).toEqual({ kind: `guest` });
        expect(access.can(`agent.reply`)).toBe(true);
    });

    it(`takes the daemon's own answer over the platform's record, agents included`, () => {
        platformRole.value = `collaborator`;
        daemonSays.value = { role: `writer`, agents: `off`, edit: `all` };
        expect(access.role.value).toBe(`writer`);
        expect(access.refusal(`agent.run`)).toEqual({ kind: `agents-off` });
        expect(access.can(`workspace.move`)).toBe(true);
    });

    // A part of the sandbox given to someone below Full access opens the routes that run it, and only those, as the
    // daemon's floors do; what they hold is read off their own answer, so it is known before the contract is.
    it(`opens the routes of a right the person was given, and no others`, () => {
        platformRole.value = `collaborator`;
        daemonSays.value = { role: `collaborator`, agents: `run`, edit: `none`, manages: [`people`] };
        expect(access.can(`GET /members`)).toBe(true);
        expect(access.can(`accessProfiles.list`)).toBe(true);
        expect(access.refusal(`secrets.setGate`)).toEqual({ kind: `tier`, floor: `maintainer` });
        expect(access.holds(`people`)).toBe(true);
        expect(access.holds(`secrets`)).toBe(false);
    });

    it(`holds every right for the owner and Full access, and none before the tier is known`, () => {
        expect(access.holds(`people`)).toBe(false);
        platformRole.value = `owner`;
        expect(access.holds(`ownAccounts`)).toBe(true);
        platformRole.value = `maintainer`;
        daemonSays.value = { role: `maintainer`, agents: `run`, edit: `all` };
        expect(access.holds(`privacy`)).toBe(true);
    });

    it(`refuses nothing for the owner`, () => {
        platformRole.value = `owner`;
        expect(access.can(`capabilities.list`)).toBe(true);
        expect(access.can(`agents.land`, { id: `abc` })).toBe(true);
    });

    it(`forecasts for the active sandbox alone, whose person it knows`, () => {
        platformRole.value = `viewer`;
        expect(forecastRefusal(`s1`, `GET`, `/capabilities`, undefined)).toEqual({ error: `maintainer access required`, floor: `maintainer`, reason: `floor` });
        expect(forecastRefusal(`s2`, `GET`, `/capabilities`, undefined)).toBeUndefined();
        expect(forecastRefusal(`s1`, `GET`, `/agents`, undefined)).toBeUndefined();
    });
});
