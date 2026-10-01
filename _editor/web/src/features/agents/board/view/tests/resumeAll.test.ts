import { ref } from "vue";
import { NO_ATTENTION } from "../../../fleet/agentStatus";
import type { FleetAgent } from "../../../fleet/useAgents-fleet";
import { useResumeAll } from "../resumeAll";

// Seven subagents stopped by one provider's limit got one Continue each; the board now offers one press for them all.
const stopped = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    status: `error`,
    provider: `zai`,
    harness: `native`,
    updatedAt: 1,
    attention: NO_ATTENTION,
    failureCode: `rate_limit`,
    limitHeld: true,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});

const setup = (fleet: FleetAgent[]) => {
    const resumeHeldTurn = jest.fn(async (_id: string) => undefined);
    const resendAtReset = jest.fn(async (_id: string) => undefined);
    const notice = ref<string | undefined>(undefined);
    const resume = useResumeAll({ fleet: ref(fleet), resumeHeldTurn, resendAtReset, notice });
    return { resume, resumeHeldTurn, resendAtReset, notice };
};

describe("useResumeAll", () => {
    it("sends every held turn again now when the provider gave no reset time", async () => {
        const { resume, resumeHeldTurn, resendAtReset } = setup([stopped(`a`), stopped(`b`)]);
        const [group] = resume.groups.value;
        expect(group).toEqual({ provider: `zai`, ids: [`a`, `b`] });
        await resume.resume(group!);
        expect([resumeHeldTurn.mock.calls, resendAtReset.mock.calls]).toEqual([[[`a`], [`b`]], []]);
    });

    it("books them all at the reset when every one of them has a reset still ahead", async () => {
        const later = Math.round(Date.now() / 1_000) + 3_600;
        const { resume, resumeHeldTurn, resendAtReset } = setup([stopped(`a`, { limitResetsAt: later }), stopped(`b`, { limitResetsAt: later })]);
        await resume.resume(resume.groups.value[0]!);
        expect([resumeHeldTurn.mock.calls, resendAtReset.mock.calls]).toEqual([[], [[`a`], [`b`]]]);
    });

    it("says on the board's strip when any of them was refused, and still tries the rest", async () => {
        const { resume, resumeHeldTurn, notice } = setup([stopped(`a`), stopped(`b`)]);
        resumeHeldTurn.mockRejectedValueOnce(new Error(`The sandbox refused it.`));
        await resume.resume(resume.groups.value[0]!);
        expect([resumeHeldTurn.mock.calls.length, notice.value]).toEqual([2, `The sandbox refused it.`]);
    });
});
