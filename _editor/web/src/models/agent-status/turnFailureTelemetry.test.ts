import { wayOutOf } from "../conversations/endings/wayOut";
import { createTurnFailureTelemetry, type FailureCard } from "./turnFailureTelemetry";

// The failure as the roster brings it, with the words a failure carries (which never leave the editor).
const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const broken: FailureCard = {
    id: `a1`,
    status: `error`,
    attention: NO_ATTENTION,
    failureCode: `workspace-broken`,
    failure: `This conversation's copy of the workspace could not be set up. (bwrap: Can't make overlay mount on /proc/self/fd/6: Invalid argument)`,
    updatedAt: 1_000,
};
const wayOut = wayOutOf(broken)!;

const recorder = () => {
    const events: { event: string; properties: unknown }[] = [];
    return { events, telemetry: createTurnFailureTelemetry((event, properties) => events.push({ event, properties })) };
};

describe(`a failed turn`, () => {
    it(`is counted once per agent, sandbox and failure, by its code and count only`, () => {
        const { events, telemetry } = recorder();
        telemetry.observe(broken, `box`);
        telemetry.observe({ ...broken, updatedAt: 2_000 }, `box`);
        // The same failure with only what varies from attempt to attempt changed is the same failure.
        telemetry.observe({ ...broken, failure: broken.failure!.replace(`fd/6`, `fd/9`) }, `box`);
        telemetry.observe(broken, `another-box`);
        // The same failure again, counted by the daemon as such, is a failure of its own.
        telemetry.observe({ ...broken, failureRepeats: 2 }, `box`);
        expect(events).toEqual([
            { event: `turn_failed`, properties: { code: `workspace-broken`, repeats: 1 } },
            { event: `turn_failed`, properties: { code: `workspace-broken`, repeats: 1 } },
            { event: `turn_failed`, properties: { code: `workspace-broken`, repeats: 2 } },
        ]);
    });

    it(`names a failure nothing coded as uncoded, and counts it again once it failed after running well`, () => {
        const { events, telemetry } = recorder();
        const { failureCode: _code, ...uncoded } = broken;
        telemetry.observe(uncoded, `box`);
        telemetry.observe({ ...uncoded, status: `ready` }, `box`);
        telemetry.observe(uncoded, `box`);
        expect(events).toEqual([
            { event: `turn_failed`, properties: { code: `uncoded`, repeats: 1 } },
            { event: `turn_failed`, properties: { code: `uncoded`, repeats: 1 } },
        ]);
    });
});

describe(`a way out`, () => {
    it(`is said shown once per failure, however many panes draw it, and again for the failure come back`, () => {
        const { events, telemetry } = recorder();
        telemetry.shown(broken, `box`, wayOut);
        telemetry.shown({ ...broken, updatedAt: 5_000 }, `box`, wayOut);
        telemetry.shown({ ...broken, failureRepeats: 3 }, `box`, { ...wayOut, repeats: 3 });
        expect(events).toEqual([
            { event: `way_out_shown`, properties: { layer: `workspace`, recommended: `newConversation`, repeats: 1 } },
            { event: `way_out_shown`, properties: { layer: `workspace`, recommended: `newConversation`, repeats: 3 } },
        ]);
    });

    it(`answers a new conversation by its own first run: well once it settled anywhere but failed`, () => {
        const { events, telemetry } = recorder();
        telemetry.taken(`newConversation`, wayOut, { sandbox: `box`, id: `fork`, since: undefined });
        const fork: FailureCard = { id: `fork`, status: `idle`, attention: NO_ATTENTION, updatedAt: 2_000 };
        // A card with nothing run yet, then its run, answer nothing; its settling does, once.
        telemetry.observe(fork, `box`);
        telemetry.observe({ ...fork, status: `running` }, `box`);
        telemetry.observe({ ...fork, status: `ready`, updatedAt: 3_000 }, `box`);
        telemetry.observe({ ...fork, status: `ready`, updatedAt: 4_000 }, `box`);
        expect(events).toEqual([
            { event: `way_out_taken`, properties: { way: `newConversation`, recommended: true, layer: `workspace` } },
            { event: `way_out_outcome`, properties: { way: `newConversation`, ok: true } },
        ]);
    });

    it(`answers trying again by the same card moving on, a refusal at the door seen only as it settled included`, () => {
        const { events, telemetry } = recorder();
        telemetry.taken(`retry`, wayOut, { sandbox: `box`, id: `a1`, since: broken.updatedAt });
        // The roster's card from before the press says nothing about it.
        telemetry.observe(broken, `box`);
        telemetry.observe({ ...broken, updatedAt: 1_500, failureRepeats: 2 }, `box`);
        expect(events).toEqual([
            { event: `way_out_taken`, properties: { way: `retry`, recommended: false, layer: `workspace` } },
            { event: `turn_failed`, properties: { code: `workspace-broken`, repeats: 1 } },
            { event: `way_out_outcome`, properties: { way: `retry`, ok: false } },
            { event: `turn_failed`, properties: { code: `workspace-broken`, repeats: 2 } },
        ]);
    });

    it(`keeps its answer to its own sandbox, and the latest way taken for one conversation`, () => {
        const { events, telemetry } = recorder();
        const unknown = wayOutOf({ status: `error`, failureRepeats: 2 })!;
        telemetry.taken(`retry`, unknown, { sandbox: `box`, id: `a1`, since: 1_000 });
        telemetry.taken(`otherModel`, unknown, { sandbox: `box`, id: `a1`, since: 1_000 });
        telemetry.observe({ ...broken, status: `running`, updatedAt: 2_000 }, `another-box`);
        telemetry.observe({ ...broken, status: `landed`, updatedAt: 3_000 }, `box`);
        expect(events).toEqual([
            { event: `way_out_taken`, properties: { way: `retry`, recommended: false, layer: `unknown` } },
            { event: `way_out_taken`, properties: { way: `otherModel`, recommended: false, layer: `unknown` } },
            { event: `way_out_outcome`, properties: { way: `otherModel`, ok: true } },
        ]);
    });
});
