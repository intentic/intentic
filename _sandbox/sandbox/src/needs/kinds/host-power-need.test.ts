import type { DeviceAgentFlow, DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import type { HostPowerFinding } from "@intentic/sandbox-contract/schemas/host-power";
import { type DeviceFacts, hostConnectionKey } from "@intentic/sandbox-contract/schemas/hosts";
import type { HostPowerNeed, Need, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import { opt } from "../../opt.js";
import { changedOn, flowsFor, hostPowerNeed } from "./host-power-need.js";

// A host-power card (2026-11-22): raised by the sandbox when work booked here would be slept through, answered by a
// maintainer, whose yes runs the computer's own `power-stay-on` op the way the Devices view's buttons do.

const SLEEP: HostPowerFinding = { id: "sleep-idle", power: "ac", afterSeconds: 18_000, fixable: true, text: "Sleeps after 5 h without input." };
const LID: HostPowerFinding = { id: "lid-close", power: "ac", action: "sleep", fixable: true, text: "Closing the lid sleeps it." };
const BATTERY: HostPowerFinding = { id: "battery-sleep", power: "dc", afterSeconds: 900, fixable: false, text: "On battery it sleeps after 15 min." };
const UPDATE: HostPowerFinding = { id: "update-restart", window: { fromHour: 1, toHour: 6 }, fixable: false, text: "Windows Update may restart it." };
const OS_SLEEP: HostPowerFinding = { id: "os-sleep", fixable: false, command: "sudo systemctl mask sleep.target", text: "The OS may suspend it." };

const factsWith = (findings: HostPowerFinding[] | undefined, features: string[] = ["power"]): DeviceFacts => ({
    os: "Windows 11 Home",
    arch: "x64",
    shell: "pwsh",
    home: "C:\\Users\\owner",
    roots: ["C:\\Users\\owner"],
    features,
    ...opt("power", findings === undefined ? undefined : { at: 1, utcOffsetMinutes: 60, findings }),
});

const needOf = (findings: HostPowerFinding[], device = "rog"): Need => ({
    id: "need-1",
    conversationId: "conv-a",
    subject: { kind: "host-power", device, findings, dueAt: 10 },
    title: "rog would sleep through work booked here",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
});

interface Harness {
    readonly kind: ReturnType<typeof hostPowerNeed>;
    readonly ran: { device: string; flow: DeviceAgentFlow }[];
    readonly refreshed: string[];
    readonly state: { facts: DeviceFacts | undefined; online: boolean; frames: DeviceFlowLine[]; after: DeviceFacts | undefined; refreshFails: boolean; throws?: string };
}

const harness = (): Harness => {
    const ran: Harness["ran"] = [];
    const refreshed: string[] = [];
    const state: Harness["state"] = {
        facts: factsWith([SLEEP, LID, BATTERY]),
        online: true,
        frames: [
            { kind: "line", text: "Sleep after (mains): 5 h -> never" },
            { kind: "line", text: "Closing the lid (mains): sleep -> do nothing" },
            { kind: "result", message: "The power settings were changed on this device." },
        ],
        after: factsWith([BATTERY]),
        refreshFails: false,
    };
    const kind = hostPowerNeed({
        facts: () => state.facts,
        online: () => state.online,
        async *runAgentFlow (device, flow) {
            ran.push({ device, flow });
            if (state.throws !== undefined) {
                throw new Error(state.throws);
            }
            yield* state.frames;
        },
        refresh: async (device) => {
            refreshed.push(device);
            if (state.refreshFails) {
                throw new Error("rog did not answer");
            }
            state.facts = state.after;
        },
    });
    return { kind, ran, refreshed, state };
};

const approve = { kind: "approve" } as const;
const maintainer = { email: "owner@example.com", maintainer: true } as const;

describe("host-power need", () => {
    it("is never raised by an agent's ask, never tells the agent, and is one card per computer", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "secret", name: "X" }, { conversationId: "conv-a", standing: undefined })).toMatchObject({ kind: "refused" });
        expect(kind.tellsAgent).toBe(false);
        expect(kind.nextTurn(needOf([LID]))).toBe(false);
        const subject: NeedSubject = { kind: "host-power", device: "rog", findings: [LID] };
        expect(kind.key(subject)).toBe("rog");
    });

    it("lets only a maintainer signed in answer it, yes or no, as the Devices view's own door does", () => {
        const { kind } = harness();
        expect(kind.mayAnswer?.(needOf([LID]), maintainer)).toBeUndefined();
        // An operator panel's token or an extension's reaches the answer route with nobody behind it.
        expect(kind.mayAnswer?.(needOf([LID]), { email: undefined })).toBe(
            "Only a sandbox maintainer, signed in, can change a connected computer's power settings or dismiss this.",
        );
    });

    it("is met by the settings as held, when the owner changed them by hand, and never pulls the computer for it", async () => {
        const { kind, state, refreshed } = harness();
        expect(await kind.check(needOf([SLEEP, LID, BATTERY]))).toBeUndefined();
        // Battery sleep is reported, never changed: its staying is no reason to keep the card up.
        state.facts = factsWith([BATTERY]);
        expect(await kind.check(needOf([SLEEP, LID, BATTERY]))).toEqual({ result: "rog's settings no longer stop work left running on it.", use: [] });
        // No power facts at all (an agent older than the field, or offline and never read): nothing to say.
        state.facts = factsWith(undefined);
        expect(await kind.check(needOf([SLEEP, LID]))).toBeUndefined();
        expect(refreshed).toEqual([]);
    });

    it("watches what a person runs a command for when nothing on the card is the agent's to change, and never an update restart", async () => {
        const { kind, state } = harness();
        state.facts = factsWith([OS_SLEEP]);
        expect(await kind.check(needOf([OS_SLEEP]))).toBeUndefined();
        state.facts = factsWith([]);
        expect(await kind.check(needOf([OS_SLEEP]))).toMatchObject({ result: "rog's settings no longer stop work left running on it." });
        expect(await kind.check(needOf([UPDATE]))).toBeUndefined();
    });

    it("runs power-stay-on on a yes, reads the computer again, and says what changed in its own words", async () => {
        const { kind, ran, refreshed } = harness();
        expect(await kind.answer(needOf([SLEEP, LID, BATTERY]), approve, maintainer)).toEqual({
            status: "met",
            result: "Changed on rog: Sleep after (mains): 5 h -> never Closing the lid (mains): sleep -> do nothing",
            use: [],
        });
        expect(ran).toEqual([{ device: "rog", flow: { op: "power-stay-on" } }]);
        expect(refreshed).toEqual(["rog"]);
    });

    it("keeps a change the computer made when it does not describe itself again in time", async () => {
        const { kind, state } = harness();
        state.refreshFails = true;
        expect(await kind.answer(needOf([SLEEP, LID]), approve, maintainer)).toMatchObject({ status: "met" });
    });

    it("leaves the card waiting with the computer's refusal, in its words", async () => {
        const { kind, state, refreshed } = harness();
        state.frames = [
            { kind: "line", text: "Changing the power plan" },
            { kind: "error", message: "powercfg refused: Access is denied." },
        ];
        expect(await kind.answer(needOf([SLEEP, LID]), approve, maintainer)).toEqual({ refused: "powercfg refused: Access is denied." });
        expect(refreshed).toEqual([]);
        state.throws = "rog is offline: it has not connected since this sandbox started.";
        expect(await kind.answer(needOf([SLEEP, LID]), approve, maintainer)).toEqual({
            refused: "rog is offline: it has not connected since this sandbox started.",
        });
    });

    it("takes a run that lost the computer before it said it finished as a change only when the fresh settings show one", async () => {
        const lost: DeviceFlowLine[] = [{ kind: "line", text: "Lost contact with rog." }];
        const { kind, state } = harness();
        state.frames = lost;
        state.after = factsWith([SLEEP, LID, BATTERY]);
        expect(await kind.answer(needOf([SLEEP, LID]), approve, maintainer)).toEqual({
            refused: "rog stopped answering before it said its settings changed: press again once it is back.",
        });
        state.after = factsWith([BATTERY]);
        expect(await kind.answer(needOf([SLEEP, LID]), approve, maintainer)).toMatchObject({ status: "met", result: "Changed on rog: Lost contact with rog." });
    });

    it("refuses at once, running nothing, when the computer is away, its agent is too old, or nothing on the card is changeable", async () => {
        const { kind, state, ran } = harness();
        state.online = false;
        expect(await kind.answer(needOf([LID]), approve, maintainer)).toEqual({
            refused: "rog is not connected right now, so nothing can change its settings: wake it or open its lid, then press again.",
        });
        state.online = true;
        state.facts = factsWith([LID], ["remote"]);
        expect(await kind.answer(needOf([LID]), approve, maintainer)).toEqual({
            refused: "rog's agent is older than this: update it from the Devices view, then press again.",
        });
        state.facts = factsWith([UPDATE]);
        expect(await kind.answer(needOf([UPDATE]), approve, maintainer)).toEqual({
            refused: "Nothing on this card is a setting rog's agent can change: what it says is done on rog itself.",
        });
        expect(ran).toEqual([]);
    });

    it("names the computer by its card, whichever of its environments the need names", async () => {
        const { kind, state } = harness();
        state.online = false;
        expect(await kind.answer(needOf([LID], hostConnectionKey("rog", "wsl:archlinux")), approve, maintainer)).toMatchObject({
            refused: expect.stringMatching(/^rog is not connected/),
        });
    });

    it("takes nothing but an approval as a yes", async () => {
        const { kind } = harness();
        expect(await kind.answer(needOf([LID]), { kind: "release" }, maintainer)).toEqual({ refused: "A power card is answered by approving the change, or declined." });
    });
});

describe("host-power need: Windows Update's night restart (2026-11-27)", () => {
    // rog: active 08:00 to 02:00, an hour east of UTC, its sandboxes on intentic's engine, the start before sign-in off.
    const NOW = Date.UTC(2026, 10, 26, 23, 35);
    const FRIDAY_FIVE = Date.UTC(2026, 10, 28, 4, 0);
    const FRIDAY_EIGHT = Date.UTC(2026, 10, 28, 7, 0);
    const RESTART: HostPowerFinding = {
        id: "update-restart",
        window: { fromHour: 2, toHour: 8 },
        fixable: false,
        offers: ["update-pause", "before-sign-in"],
        comesBack: "sign-in",
        text: "Windows Update may restart it between 02:00 and 08:00.",
    };
    const card = (findings: HostPowerFinding[]): Need => ({ ...needOf(findings), subject: { kind: "host-power", device: "rog", findings, dueAt: FRIDAY_FIVE } });
    const both = ["power", "power-restart"];

    const restartHarness = (findings: HostPowerFinding[], after: HostPowerFinding[]) => {
        const ran: DeviceAgentFlow[] = [];
        const state = { facts: factsWith(findings, both) };
        const kind = hostPowerNeed({
            facts: () => state.facts,
            online: () => true,
            async *runAgentFlow (_device, flow) {
                ran.push(flow);
                yield { kind: "line", text: `ran ${flow.op}` };
                yield { kind: "result", message: "done" };
            },
            refresh: async () => {
                state.facts = factsWith(after, both);
            },
            now: () => NOW,
        });
        return { kind, ran, state };
    };

    it("pauses Windows Update until the end of the window the work falls in, by default, and is met once the pause reaches past it", async () => {
        const { kind, ran } = restartHarness([RESTART], [{ ...RESTART, pausedUntil: FRIDAY_EIGHT }]);
        expect(await kind.answer(card([RESTART]), approve, maintainer)).toMatchObject({ status: "met", result: "Changed on rog: ran update-pause" });
        expect(ran).toEqual([{ op: "update-pause", until: FRIDAY_EIGHT }]);
        expect(await kind.check(card([RESTART]))).toMatchObject({ result: "rog's settings no longer stop work left running on it." });
    });

    it("turns on the start before sign-in when that is the answer chosen, after stay-on where the card holds what it changes", async () => {
        const { kind, ran } = restartHarness([SLEEP, RESTART], [{ ...RESTART, comesBack: "boot", offers: ["update-pause"] }]);
        expect(await kind.answer(card([SLEEP, RESTART]), { kind: "approve", remedy: "before-sign-in" }, maintainer)).toMatchObject({ status: "met" });
        expect(ran).toEqual([{ op: "power-stay-on" }, { op: "before-sign-in" }]);
    });

    it("stays open while the restart would still stop the work, and is met when the PC brings its sandboxes back by itself", async () => {
        const { kind, state } = restartHarness([RESTART], []);
        expect(await kind.check(card([RESTART]))).toBeUndefined();
        // A pause that ends before the window the work falls in does not answer it.
        state.facts = factsWith([{ ...RESTART, pausedUntil: Date.UTC(2026, 10, 27, 5, 0) }], both);
        expect(await kind.check(card([RESTART]))).toBeUndefined();
        state.facts = factsWith([{ ...RESTART, comesBack: "boot" }], both);
        expect(await kind.check(card([RESTART]))).toMatchObject({ result: "rog's settings no longer stop work left running on it." });
    });

    it("refuses an answer the card does not offer, and one an agent too old to carry it would drop, running nothing", async () => {
        const { kind, ran, state } = restartHarness([RESTART], []);
        const pauseOnly = { ...RESTART, offers: ["update-pause"] };
        expect(await kind.answer(card([pauseOnly]), { kind: "approve", remedy: "before-sign-in" }, maintainer)).toEqual({
            refused: "This card does not offer starting its sandboxes before anyone signs in on rog.",
        });
        state.facts = factsWith([RESTART], ["power"]);
        expect(await kind.answer(card([RESTART]), approve, maintainer)).toEqual({
            refused: "rog's agent is older than this: update it from the Devices view, then press again.",
        });
        expect(ran).toEqual([]);
    });
});

describe("flowsFor", () => {
    const RESTART: HostPowerFinding = { id: "update-restart", fixable: false, offers: ["update-pause"], text: "Windows Update may restart it." };
    const subject = (dueAt: number): HostPowerNeed => ({ kind: "host-power", device: "rog", findings: [RESTART], dueAt });

    it("pauses two hours past the work where no window was said, and refuses work further off than Windows pauses for", () => {
        const facts = factsWith([RESTART], ["power", "power-restart"]);
        expect(flowsFor(subject(10 * 3_600_000), undefined, facts, 0)).toEqual([{ op: "update-pause", until: 12 * 3_600_000 }]);
        expect(flowsFor(subject(40 * 24 * 3_600_000), undefined, facts, 0)).toEqual({
            refused: "The booked work is further off than Windows lets updates be paused (five weeks): nothing was changed on rog.",
        });
    });
});

describe("changedOn", () => {
    it("keeps the computer's last lines, cut to a card's length, and falls back to its closing sentence, then to a plain one", () => {
        const many = Array.from({ length: 10 }, (_, at) => `line ${at}`);
        expect(changedOn("rog", many, undefined)).toBe("Changed on rog: line 4 line 5 line 6 line 7 line 8 line 9");
        expect(changedOn("rog", ["  ", ""], "Done on this device.")).toBe("Changed on rog: Done on this device.");
        expect(changedOn("rog", [], undefined)).toBe("rog's power settings were changed on mains power.");
        expect(changedOn("rog", ["x".repeat(700)], undefined)).toHaveLength("Changed on rog: ".length + 600);
    });
});
