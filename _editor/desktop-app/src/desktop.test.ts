import { describe, expect, it } from "bun:test";
import {
    EXIT_NEEDS_CONSENT,
    EXIT_NEEDS_RESTART,
    expectedStop,
    parseCommandFailure,
    parseRequirement,
    parseRequirementState,
    parseStep,
} from "./desktop";

// Fixtures are unedited output from a real failed Windows install (no WSL2, no Docker, no docker-users, no running
// engine). A parser that stops matching them can no longer explain a failed install.

// Copied from the report, byte for byte.
const REPORTED = [
    `intentic: [fetching-ic] fetching the ic CLI...`,
    `intentic: [checking-docker] checking this PC for Docker...`,
    `intentic: Windows 10 Pro 25H2, build 26200`,
    `  ok    This PC`,
    `  FAIL  WSL2 — Docker runs its Linux engine inside WSL2, and the two Windows features it needs (Windows Subsystem for Linux and Virtual Machine Platform) are switched off.`,
    `intentic-requirement: {"action":"fixElevated","detail":null,"id":"wsl-features","problem":"Docker runs its Linux engine inside WSL2, and the two Windows features it needs (Windows Subsystem for Linux and Virtual Machine Platform) are switched off.","remedy":"We will turn them on. Windows asks for permission once, and then needs a restart.","title":"Windows features for Docker"}`,
    `intentic-requirement: {"action":"fix","detail":null,"id":"docker-desktop","problem":"Docker Desktop is not installed on this PC.","remedy":"We will download it from docker.com and install it (about 600 MB). Windows asks for permission once.","title":"Docker Desktop"}`,
    `intentic-requirement: {"action":"fixElevated","detail":null,"id":"docker-users","problem":"vicheta-asus does not have permission to use Docker on this PC yet.","remedy":"We will grant it. Windows asks for permission once, and then you need to sign out and back in.","title":"Permission to use Docker"}`,
    `intentic-requirement: {"action":"fix","detail":null,"id":"docker-running","problem":"Docker Desktop is not running.","remedy":"We will start it and wait for its engine to come up. If it shows a welcome screen, accept it.","title":"Docker Desktop running"}`,
];

describe(`the reported install, read back`, () => {
    it(`finds every requirement that machine named`, () => {
        const found = REPORTED.map(parseRequirement).filter((requirement) => requirement !== undefined);
        expect(found.map((requirement) => requirement.id)).toEqual([`wsl-features`, `docker-desktop`, `docker-users`, `docker-running`]);
        // Requirements needing administrator must be distinguishable, so users are warned about UAC, not surprised.
        expect(found.map((requirement) => requirement.action)).toEqual([`fixElevated`, `fix`, `fixElevated`, `fix`]);
        expect(found[0]?.title).toBe(`Windows features for Docker`);
        expect(found[1]?.remedy).toContain(`600 MB`);
        // `"detail":null` means no long form; it must not render as the string "null".
        expect(found.every((requirement) => requirement.detail === undefined)).toBe(true);
    });

    it(`reads the two phases and treats everything else as narration`, () => {
        expect(parseStep(REPORTED[0] ?? ``)?.phase).toBe(`fetching-ic`);
        expect(parseStep(REPORTED[1] ?? ``)).toEqual({ phase: `checking-docker`, message: `checking this PC for Docker...` });
        // Version line, checklist rows and requirement JSON are all detail under the running step, not new phases.
        for (const line of REPORTED.slice(2)) {
            expect(parseStep(line)).toBeUndefined();
        }
    });

    it(`never confuses a requirement with a step, in either direction`, () => {
        const requirement = REPORTED[5] ?? ``;
        expect(parseStep(requirement)).toBeUndefined();
        expect(parseRequirement(REPORTED[1] ?? ``)).toBeUndefined();
        // Nor with the state marker, whose prefix differs by one hyphen.
        expect(parseRequirement(`intentic-requirement-state: {"id":"wsl-features","state":"running","detail":null}`)).toBeUndefined();
    });
});

describe(`how one requirement is going`, () => {
    it(`reads a row's state and the measurement under it`, () => {
        expect(
            parseRequirementState(`intentic-requirement-state: {"id":"docker-desktop","state":"running","detail":"downloaded 275 MB of 612 MB"}`),
        ).toEqual({
            id: `docker-desktop`,
            state: `running`,
            detail: `downloaded 275 MB of 612 MB`,
        });
        expect(parseRequirementState(`intentic-requirement-state: {"id":"wsl-features","state":"done","detail":null}`)).toEqual({
            id: `wsl-features`,
            state: `done`,
        });
        expect(
            parseRequirementState(`intentic-requirement-state: {"id":"docker-running","state":"failed","detail":"its engine never came up"}`)?.state,
        ).toBe(`failed`);
    });

    it(`refuses anything it cannot key or draw`, () => {
        // No id: nothing to attach it to. Unknown state: nothing to draw. Truncated input must not crash it.
        expect(parseRequirementState(`intentic-requirement-state: {"state":"running"}`)).toBeUndefined();
        expect(parseRequirementState(`intentic-requirement-state: {"id":"x","state":"sideways"}`)).toBeUndefined();
        expect(parseRequirementState(`intentic-requirement-state: {"id":"x","sta`)).toBeUndefined();
        expect(parseRequirementState(`  ok    This PC`)).toBeUndefined();
    });
});

describe(`which non-zero exits are failures`, () => {
    // Every Windows install's first pass exits non-zero by design (it reports what it would change and stops, with no
    // way to ask the user yet); treating that as a crash misreads the design.
    it(`treats the two designed stops as stops and everything else as a failure`, () => {
        expect(expectedStop(EXIT_NEEDS_CONSENT)).toBe(true);
        expect(expectedStop(EXIT_NEEDS_RESTART)).toBe(true);
        expect(expectedStop(1)).toBe(false);
        expect(expectedStop(0)).toBe(false);
        // A process that was killed rather than exiting reports no code at all.
        expect(expectedStop(null)).toBe(false);
    });

    it(`keeps the codes as they are, because a shim passes them through unread`, () => {
        // connect.ps1 does `exit $LASTEXITCODE`; codes are ic's (prepare/mod.rs), released separately.
        expect([EXIT_NEEDS_CONSENT, EXIT_NEEDS_RESTART]).toEqual([3, 4]);
    });
});

describe(`a child command reporting terminal failure`, () => {
    const reported = `Command failed, intentic-launch.exe did not answer within 10000ms. Details: C:\\Users\\radar\\.intentic\\machine\\machine.log`;

    it(`reads the reason from the reported Windows failure`, () => {
        expect(parseCommandFailure({ kind: `line`, run: `setup`, stream: `stderr`, text: reported })).toBe(
            `intentic-launch.exe did not answer within 10000ms. Details: C:\\Users\\radar\\.intentic\\machine\\machine.log`,
        );
    });

    it(`does not turn warnings, stdout, or an exit event into early failures`, () => {
        expect(parseCommandFailure({ kind: `line`, run: `setup`, stream: `stderr`, text: `enrolling: retrying (1/5)` })).toBeUndefined();
        expect(parseCommandFailure({ kind: `line`, run: `setup`, stream: `stdout`, text: reported })).toBeUndefined();
        expect(parseCommandFailure({ kind: `exit`, run: `setup`, code: 1, ok: false })).toBeUndefined();
    });
});
