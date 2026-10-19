import { admitMove, type ChildGate, PASS, seatLine } from "../child-admission.js";

// One admission for every move on a child: gates run in order, a refusal ends it, a hold stands unless a later gate
// refuses, and whatever does not simply go is logged with the gate that decided it.

const gate = (name: ChildGate<null>["name"], answer: ReturnType<ChildGate<null>["judge"]>, ran: string[]): ChildGate<null> => ({
    name,
    judge: () => {
        ran.push(name);
        return answer;
    },
});

// What the admission writes down, kept for the test to read.
interface Logged {
    readonly lines: Record<string, string>[];
    readonly info: (fields: Record<string, string>) => void;
}
const logged = (): Logged => {
    const lines: Record<string, string>[] = [];
    return { lines, info: (fields) => void lines.push(fields) };
};

describe("a move through its gates", () => {
    it("goes when every gate lets it through, and logs nothing", async () => {
        const ran: string[] = [];
        const log = logged();
        expect(await admitMove([gate("depth", PASS, ran), gate("rules", PASS, ran)], null, { kind: "spawn", parent: "p" }, log)).toEqual({ kind: "proceed" });
        expect(ran).toEqual(["depth", "rules"]);
        expect(log.lines).toEqual([]);
    });

    it("stops at the first refusal, naming its gate, and asks no gate after it", async () => {
        const ran: string[] = [];
        const log = logged();
        const verdict = await admitMove(
            [gate("depth", PASS, ran), gate("spent", { refuse: "Spent until 5pm." }, ran), gate("rules", { hold: "asks first" }, ran)],
            null,
            { kind: "spawn", parent: "p" },
            log,
        );
        expect(verdict).toEqual({ kind: "refuse", gate: "spent", message: "Spent until 5pm." });
        expect(ran).toEqual(["depth", "spent"]);
        expect(log.lines).toEqual([{ move: "spawn", parent: "p", gate: "spent", verdict: "refuse", why: "Spent until 5pm." }]);
    });

    it("holds for the owner only where no later gate refuses, since their yes cannot make a refused move go", async () => {
        const ran: string[] = [];
        const held = await admitMove([gate("rules", { hold: "asks first" }, ran), gate("depth", PASS, ran)], null, { kind: "send", parent: "p", child: "c" }, logged());
        expect(held).toEqual({ kind: "hold", gate: "rules", reason: "asks first" });
        const log = logged();
        const refused = await admitMove([gate("rules", { hold: "asks first" }, ran), gate("depth", { refuse: "Too deep." }, ran)], null, { kind: "send", parent: "p", child: "c" }, log);
        expect(refused).toEqual({ kind: "refuse", gate: "depth", message: "Too deep." });
        expect(log.lines).toEqual([{ move: "send", parent: "p", child: "c", gate: "depth", verdict: "refuse", why: "Too deep." }]);
    });
});

describe("starts waiting for a seat", () => {
    it("go oldest first, one per freed seat, per parent", async () => {
        const line = seatLine();
        const started: string[] = [];
        const waiter = (childId: string) => ({
            childId,
            start: async () => {
                started.push(childId);
                return true;
            },
        });
        line.wait("p", waiter("a"));
        line.wait("p", waiter("b"));
        line.wait("q", waiter("c"));
        line.freed("p");
        await Promise.resolve();
        expect(started).toEqual(["a"]);
        expect(line.waiting("p")).toBe(1);
        line.freed("q");
        line.freed("p");
        await Promise.resolve();
        expect(started).toEqual(["a", "c", "b"]);
        expect(line.waiting("p")).toBe(0);
    });

    it("keeps a start that found no seat after all at the head of its line", async () => {
        const line = seatLine();
        let seats = 0;
        const started: string[] = [];
        line.wait("p", {
            childId: "a",
            start: async () => {
                if (seats === 0) {
                    return false;
                }
                started.push("a");
                return true;
            },
        });
        line.wait("p", { childId: "b", start: async () => Boolean(started.push("b")) });
        line.freed("p");
        await Promise.resolve();
        expect(started).toEqual([]);
        seats = 1;
        line.freed("p");
        await Promise.resolve();
        expect(started).toEqual(["a"]);
    });

    it("lets a cancelled start off its line", () => {
        const line = seatLine();
        line.wait("p", { childId: "a", start: async () => true });
        expect(line.withdraw("p", "a")).toBe(true);
        expect(line.withdraw("p", "a")).toBe(false);
        expect(line.waiting("p")).toBe(0);
    });
});
