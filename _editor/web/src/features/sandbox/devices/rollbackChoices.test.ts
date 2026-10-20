// The versions a row's Roll back offers: every image the machine kept, when the agent the op goes through can be sent
// `to` at all. An older agent refuses the field outright, so it is never offered one.
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { rollbackChoices } from "./rollbackChoices";

const takesTo: Pick<DeviceFacts, "features"> = { features: [`set-shape`, `rollback-to`] };
const kept = {
    rollbackTargets: [
        { image: `intentic-sandbox:rollback-work-1`, version: `1.315.0` },
        { image: `intentic-sandbox:rollback-work-2`, version: `1.314.0` },
        { image: `ghcr.io/intentic/sandbox@sha256:0123456789abcdef0123` },
    ],
};

it(`offers every kept version newest first, the newest as the plain rollback and the rest by what they are`, () => {
    expect(rollbackChoices(takesTo, kept)).toEqual([
        { version: `1.315.0`, to: undefined },
        // Sent as the exact image `ic` listed, never the version it names (versions.rs ways_back).
        { version: `1.314.0`, to: `intentic-sandbox:rollback-work-2` },
        // An image that would not say its version is named by its pinned image, and shown by its short digest.
        { version: `sandbox@sha256:0123456789ab`, to: `ghcr.io/intentic/sandbox@sha256:0123456789abcdef0123` },
    ]);
});

it(`offers no choice to an agent that can't take one, or where there is only the one version to go back to`, () => {
    expect(rollbackChoices({ features: [`set-shape`] }, kept)).toEqual([]);
    expect(rollbackChoices(undefined, kept)).toEqual([]);
    expect(rollbackChoices(takesTo, { rollbackTargets: kept.rollbackTargets.slice(0, 1) })).toEqual([]);
    expect(rollbackChoices(takesTo, undefined)).toEqual([]);
});

// Every dev build says 0.0.0: three menu rows reading the same and a `to` of "0.0.0" that `ic` resolves to the first
// kept build, whichever row was pressed (2026-10-08).
it(`tells kept builds that share a version apart by their image, and sends the image rather than the version`, () => {
    const dev = {
        rollbackTargets: [
            { image: `intentic-sandbox-rollback-s1:c6cc76cfeece`, version: `0.0.0` },
            { image: `intentic-sandbox-rollback-s1:f5eb7476ff5c`, version: `0.0.0` },
            { image: `intentic-sandbox-rollback-s1:aaaaaaaaaaaa`, version: `1.2.0` },
        ],
    };
    expect(rollbackChoices(takesTo, dev)).toEqual([
        { version: `0.0.0 (c6cc76cfeece)`, to: undefined },
        { version: `0.0.0 (f5eb7476ff5c)`, to: `intentic-sandbox-rollback-s1:f5eb7476ff5c` },
        { version: `1.2.0`, to: `intentic-sandbox-rollback-s1:aaaaaaaaaaaa` },
    ]);
});

// Which ways back can be had is ic's to say (versions.rs ways_back); the menu offers each distinct one once, so two rows
// can never start the same rollback (2026-10-08, 2026-10-19: three rows of "0.0.0").
it(`offers one row per image ic listed, each sent as that image`, () => {
    const release = { image: `ghcr.io/intentic/sandbox:1.2.0`, version: `1.2.0`, download: true };
    const local = { image: `intentic-sandbox-rollback-s1:c6cc76cfeece`, version: `0.0.0` };
    expect(rollbackChoices(takesTo, { rollbackTargets: [local, release, release] })).toEqual([
        { version: `0.0.0`, to: undefined },
        { version: `1.2.0`, to: `ghcr.io/intentic/sandbox:1.2.0` },
    ]);
    expect(rollbackChoices(takesTo, { rollbackTargets: [release, release, release] })).toEqual([]);
});

// 2026-10-20: a host whose ic predates the reachable listing still lists a pruned dev build as a download of 0.0.0. Its
// facts lack `reachable-ways-back`, so that row goes; a current ic's rows are offered as it listed them.
it(`leaves out what an older ic listed and could never reach, and nothing a current ic listed`, () => {
    const gone = { image: `intentic-sandbox-rollback-s1:c6cc76cfeece`, version: `0.0.0`, download: true };
    const release = { image: `ghcr.io/intentic/sandbox:1.2.0`, version: `1.2.0`, download: true };
    const local = { image: `intentic-sandbox-rollback-s1:aaaaaaaaaaaa`, version: `1.3.0` };
    expect(rollbackChoices(takesTo, { rollbackTargets: [local, gone, release] })).toEqual([
        { version: `1.3.0`, to: undefined },
        { version: `1.2.0`, to: `ghcr.io/intentic/sandbox:1.2.0` },
    ]);
    const current = { features: [`rollback-to`, `reachable-ways-back`] };
    expect(rollbackChoices(current, { rollbackTargets: [local, gone] }).map((choice) => choice.version)).toEqual([`1.3.0`, `0.0.0`]);
});
