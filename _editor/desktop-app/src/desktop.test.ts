import { describe, expect, it } from "vitest";
import { EXIT_NEEDS_CONSENT, EXIT_NEEDS_RESTART, expectedStop, parseRequirement, parseRequirementState, parseStep } from "./desktop";

/* WHAT THE INSTALLER SAYS, AND WHETHER THIS WINDOW HEARS IT.
 *
 * These are the readings a Windows install's whole diagnosis passes through, and the reason they are pinned
 * is a real report: a PC with no WSL2, no Docker Desktop, no docker-users membership and no running engine
 * named all four, printed the four `intentic-requirement:` lines below verbatim, exited — and the window
 * showed a spinner on "checking Docker" and never mentioned any of it.
 *
 * The fixtures are that machine's actual output, pasted unedited. A parser that stops matching it is a
 * parser that has stopped being able to explain a failed install. */

// Copied from the report, byte for byte.
const REPORTED = [
    `intentic: [fetching-ic] fetching the ic CLI...`,
    `intentic: [checking-docker] checking this PC for Docker...`,
    `intentic: Windows 10 Pro 25H2, build 26200`,
    `  ok    This PC`,
    `  FAIL  WSL2 — Windows Subsystem for Linux and Virtual Machine Platform are both off. Docker runs Linux containers inside WSL2, so they have to be on first.`,
    `intentic-requirement: {"action":"fixElevated","detail":null,"id":"wsl-features","problem":"Windows Subsystem for Linux and Virtual Machine Platform are both off. Docker runs Linux containers inside WSL2, so they have to be on first.","remedy":"turn them on with \`wsl --install --no-distribution\` (Windows will ask for administrator), then restart.","title":"WSL2"}`,
    `intentic-requirement: {"action":"fix","detail":null,"id":"docker-desktop","problem":"Docker Desktop is not installed.","remedy":"download Docker Desktop from docker.com and install it (about 600 MB) - this PC has no Windows package manager, so the installer is fetched directly.","title":"Docker Desktop"}`,
    `intentic-requirement: {"action":"fixElevated","detail":null,"id":"docker-users","problem":"vicheta-asus is not in this PC's docker-users group, so Docker will refuse the connection.","remedy":"add this account to docker-users (Windows will ask for administrator), then sign out and back in.","title":"Permission to use Docker"}`,
    `intentic-requirement: {"action":"fix","detail":null,"id":"docker-running","problem":"Docker Desktop is not running.","remedy":"start it and wait for its engine to come up.","title":"Docker running"}`,
];

describe(`the reported install, read back`, () => {
    it(`finds every requirement that machine named`, () => {
        const found = REPORTED.map(parseRequirement).filter((requirement) => requirement !== undefined);
        expect(found.map((requirement) => requirement.id)).toEqual([`wsl-features`, `docker-desktop`, `docker-users`, `docker-running`]);
        // The two that need administrator have to be distinguishable from the two that do not: it is the
        // difference between warning somebody about a UAC prompt and surprising them with one.
        expect(found.map((requirement) => requirement.action)).toEqual([`fixElevated`, `fix`, `fixElevated`, `fix`]);
        expect(found[0]?.title).toBe(`WSL2`);
        expect(found[1]?.remedy).toContain(`600 MB`);
        // `"detail":null` is what the installer prints when there is no long form — it must not become the
        // string "null" under a row.
        expect(found.every((requirement) => requirement.detail === undefined)).toBe(true);
    });

    it(`reads the two phases and treats everything else as narration`, () => {
        expect(parseStep(REPORTED[0] ?? ``)?.phase).toBe(`fetching-ic`);
        expect(parseStep(REPORTED[1] ?? ``)).toEqual({ phase: `checking-docker`, message: `checking this PC for Docker...` });
        // The version line, the checklist rows and the requirement JSON are all detail under the running
        // step. A parser that took any of them for a phase would slide the bar somewhere that does not exist.
        for (const line of REPORTED.slice(2)) {
            expect(parseStep(line)).toBeUndefined();
        }
    });

    it(`never confuses a requirement with a step, in either direction`, () => {
        const requirement = REPORTED[5] ?? ``;
        expect(parseStep(requirement)).toBeUndefined();
        expect(parseRequirement(REPORTED[1] ?? ``)).toBeUndefined();
        // …nor with the state marker, whose prefix is one hyphen away from it.
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
        // No id: nothing to attach it to. Unknown state: nothing to draw. Truncated: a pipe that closed
        // mid-write must not take the screen with it.
        expect(parseRequirementState(`intentic-requirement-state: {"state":"running"}`)).toBeUndefined();
        expect(parseRequirementState(`intentic-requirement-state: {"id":"x","state":"sideways"}`)).toBeUndefined();
        expect(parseRequirementState(`intentic-requirement-state: {"id":"x","sta`)).toBeUndefined();
        expect(parseRequirementState(`  ok    This PC`)).toBeUndefined();
    });
});

describe(`which non-zero exits are failures`, () => {
    /* Every Windows install that needs anything ends its first pass non-zero on purpose: the installer
     * reports what it would change and stops, because there is no terminal here to ask the one question on.
     * Reporting that as a crash is this screen calling its own design broken — and on the run that was
     * reported to us, the red box was the only thing with anything to say. */
    it(`treats the two designed stops as stops and everything else as a failure`, () => {
        expect(expectedStop(EXIT_NEEDS_CONSENT)).toBe(true);
        expect(expectedStop(EXIT_NEEDS_RESTART)).toBe(true);
        expect(expectedStop(1)).toBe(false);
        expect(expectedStop(0)).toBe(false);
        // A process that was killed rather than exiting reports no code at all.
        expect(expectedStop(null)).toBe(false);
    });

    it(`keeps the codes as they are, because a shim passes them through unread`, () => {
        // connect.ps1 does `exit $LASTEXITCODE`; the numbers are `ic`'s (prepare/mod.rs) and are a contract
        // between two binaries that are released separately.
        expect([EXIT_NEEDS_CONSENT, EXIT_NEEDS_RESTART]).toEqual([3, 4]);
    });
});
