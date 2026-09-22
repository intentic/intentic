import type { SandboxVerb } from "@intentic/ui";
import { describe, test, expect } from "bun:test";
import { agentFallback, runnerFallback, sandboxFallback, syncFallback } from "./deviceFallback";

// These lines are typed by a person into their own terminal when the app can't reach the machine, so a verb that
// regresses to a different spelling is a dead end handed out as a fix. Each is asserted whole, against the CLI
// surface it has to match (ic's main.rs, the machine agent's AGENT_VERB), not against a copy of itself.

describe(`the lifecycle verbs ic owns`, () => {
    test(`each is the ic verb of the same name, named by slug`, () => {
        expect(sandboxFallback(`update`, `work`)).toBe(`ic sandbox update work`);
        expect(sandboxFallback(`rollback`, `work`)).toBe(`ic sandbox rollback work`);
        expect(sandboxFallback(`remove`, `work`)).toBe(`ic sandbox remove work`);
    });

    // The agent passes `-y` because it has no terminal to answer with; a person has one, and removal is the verb
    // where that second question is the whole safety net.
    test(`removal keeps ic's own confirmation instead of skipping it`, () => {
        expect(sandboxFallback(`remove`, `work`)).not.toContain(`-y`);
    });
});

describe(`the power verbs docker can do alone`, () => {
    test(`each names the container, not the slug: docker has never heard of a sandbox`, () => {
        expect(sandboxFallback(`start`, `work`)).toBe(`docker start intentic-sandbox-work`);
        expect(sandboxFallback(`stop`, `work`)).toBe(`docker stop intentic-sandbox-work`);
        expect(sandboxFallback(`restart`, `work`)).toBe(`docker restart intentic-sandbox-work`);
    });

    test(`a log tail asks for the same depth the pane would have shown`, () => {
        expect(sandboxFallback(`logs`, `work`)).toBe(`docker logs --tail 200 intentic-sandbox-work`);
    });
});

describe(`a reshape`, () => {
    test(`carries the values that were just asked for, spelled the way ic takes them`, () => {
        expect(sandboxFallback(`resources`, `work`, { memoryGib: 12, cpus: 4 })).toBe(`ic sandbox reshape work --memory 12g --cpus 4`);
        expect(sandboxFallback(`resources`, `work`, { privileged: true, gpu: false })).toBe(`ic sandbox reshape work --privileged on --gpus off`);
    });

    // null is the form's "back to what this machine derives", which ic spells `default`; dropping it would print a
    // line that sets nothing where the user asked for a reset.
    test(`spells a cleared cap as ic's own default`, () => {
        expect(sandboxFallback(`resources`, `work`, { memoryGib: null, cpus: null })).toBe(`ic sandbox reshape work --memory default --cpus default`);
    });

    // ic refuses a reshape that changes nothing, so a line carrying one would only fail a second way.
    test(`is offered no line at all when there is nothing to change`, () => {
        expect(sandboxFallback(`resources`, `work`)).toBeUndefined();
        expect(sandboxFallback(`resources`, `work`, {})).toBeUndefined();
    });
});

// A verb with no line is a row that silently offers no way out, so the absence is asserted rather than assumed:
// every verb but the empty reshape has one.
test(`every verb a row can press has a line behind it`, () => {
    const verbs: readonly SandboxVerb[] = [`start`, `stop`, `restart`, `update`, `rollback`, `resources`, `logs`, `remove`];
    for (const verb of verbs) {
        expect(sandboxFallback(verb, `work`, { cpus: 2 })).toBeTypeOf(`string`);
    }
});

test(`the agent's own two ops are the verbs its CLI takes`, () => {
    expect(agentFallback(`upgrade`)).toBe(`intentic-machine upgrade`);
    // Bare `run`: reconcileResidency stops the loop it finds before starting its own.
    expect(agentFallback(`restart`)).toBe(`intentic-machine run`);
});

describe(`a runner`, () => {
    test(`can be removed by hand, by the name the card shows`, () => {
        expect(runnerFallback(`remove`, `rig-1`)).toBe(`ic runner remove rig-1`);
    });

    // Starting one redeems a pairing the parent mints, and settings have no verb at all: a line for either would
    // be a fix that cannot work.
    test(`has no line for the two ops the CLI can't do from a standing start`, () => {
        expect(runnerFallback(`create`, `rig-1`)).toBeUndefined();
        expect(runnerFallback(`update`, `rig-1`)).toBeUndefined();
    });
});

describe(`the sync switches`, () => {
    test(`each names its pairing, so a machine syncing several isn't told to act on all of them`, () => {
        expect(syncFallback(`sync-pause`, `sandbox-abc`)).toBe(`intentic-machine sync pause --sandbox sandbox-abc`);
        expect(syncFallback(`sync-resume`, `sandbox-abc`)).toBe(`intentic-machine sync resume --sandbox sandbox-abc`);
        expect(syncFallback(`mirror-off`, `sandbox-abc`)).toBe(`intentic-machine sync mirror off --sandbox sandbox-abc`);
        expect(syncFallback(`mirror-on`, `sandbox-abc`)).toBe(`intentic-machine sync mirror on --sandbox sandbox-abc`);
        expect(syncFallback(`sync-clean`, `sandbox-abc`)).toBe(`intentic-machine sync clean --sandbox sandbox-abc`);
        expect(syncFallback(`sync-unpair`, `sandbox-abc`)).toBe(`intentic-machine sync uninstall --sandbox sandbox-abc`);
    });

    // The flag is optional in the CLI and the button is machine-wide without a pairing; adding an empty flag would
    // make the line act on nothing rather than on everything.
    test(`drops the flag entirely when the button was the machine-wide one`, () => {
        expect(syncFallback(`sync-unpair`, undefined)).toBe(`intentic-machine sync uninstall`);
    });

    // Enrolling redeems a one-time token this card mints, so a printed line would be spent before it was typed.
    test(`offers no line for the one command that needs a token`, () => {
        expect(syncFallback(`sync-install`, `sandbox-abc`)).toBeUndefined();
    });
});
