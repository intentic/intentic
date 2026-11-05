import { AgentErrorCodeSchema } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { wayOutCut, wayOutOf } from "./wayOut";

// The ways out of a failure that comes back the same: offered only for one, never in place of a press that still works.

describe(`wayOutOf`, () => {
    it(`offers a new conversation first for a broken copy of the workspace, then trying again, and no other model`, () => {
        expect(wayOutOf({ status: `error`, failureCode: `workspace-broken` })).toEqual({
            layer: `workspace`,
            repeats: 1,
            recommended: `newConversation`,
            ways: [`newConversation`, `retry`],
        });
        expect(wayOutOf({ status: `error`, failureCode: `workspace-broken`, failureRepeats: 4 })).toEqual({
            layer: `workspace`,
            repeats: 4,
            recommended: `newConversation`,
            ways: [`newConversation`, `retry`],
        });
    });

    it(`offers every way out once any failure has come back the same, counting from the second`, () => {
        expect(wayOutOf({ status: `error`, failureRepeats: 2 })).toEqual({
            layer: `unknown`,
            repeats: 2,
            recommended: `newConversation`,
            ways: [`newConversation`, `otherModel`, `retry`],
        });
        expect(wayOutOf({ status: `error`, failureCode: `provider-outage`, failureRepeats: 3 })).toEqual({
            layer: `unknown`,
            repeats: 3,
            recommended: `newConversation`,
            ways: [`newConversation`, `otherModel`, `retry`],
        });
    });

    it(`offers nothing for a failure seen once, whose press may still get past it`, () => {
        expect(wayOutOf({ status: `error` })).toBeUndefined();
        expect(wayOutOf({ status: `error`, failureCode: `provider-outage` })).toBeUndefined();
        expect(wayOutOf({ status: `error`, failureCode: `workspace-setup` })).toBeUndefined();
    });

    it(`offers nothing once the conversation is anywhere but failed, a stale count included`, () => {
        expect(wayOutOf({ status: `running`, failureCode: `workspace-broken` })).toBeUndefined();
        expect(wayOutOf({ status: `ready`, failureRepeats: 5 })).toBeUndefined();
        expect(wayOutOf({ status: undefined, failureCode: `workspace-broken`, failureRepeats: 2 })).toBeUndefined();
        expect(wayOutOf({})).toBeUndefined();
    });

    // The one code the contract marks as repeating is the one this reads as the workspace; any other the wire names, met
    // once, leaves the chat's own press.
    it(`reads only the code that repeats until repaired as the workspace`, () => {
        const once = AgentErrorCodeSchema.options.filter((code) => wayOutOf({ status: `error`, failureCode: code }) !== undefined);
        expect(once).toEqual([`workspace-broken`]);
    });
});

describe(`wayOutCut`, () => {
    const rows = (...roles: TranscriptRow[`role`][]): Pick<TranscriptRow, `role`>[] => roles.map((role) => ({ role }));

    it(`cuts above the person's last message when nothing answered it, so its words reopen in the new composer`, () => {
        expect(wayOutCut(rows(`user`, `assistant`, `notice`, `user`, `notice`, `notice`))).toBe(3);
        expect(wayOutCut(rows(`user`))).toBe(0);
        expect(wayOutCut(rows(`user`, `notice`))).toBe(0);
    });

    it(`carries the whole conversation once the model answered since, or where the person said nothing`, () => {
        expect(wayOutCut(rows(`user`, `assistant`, `notice`))).toBe(3);
        expect(wayOutCut(rows(`user`, `notice`, `assistant`))).toBe(3);
        expect(wayOutCut(rows(`notice`, `notice`))).toBe(2);
        expect(wayOutCut([])).toBe(0);
    });
});
