import { waitFor } from "@intentic/testing/bun";
import { createBufferedPainter, framePainter, type Painter } from "./painter.js";

test("the buffered painter sends nothing until end, then everything once", async () => {
    const sent: string[] = [];
    const painter = createBufferedPainter(
        async (text) => {
            sent.push(text);
        },
        () => {},
        60_000,
    );
    painter.delta("first ");
    painter.delta("second");
    expect(sent).toEqual([]);
    painter.end();
    await waitFor(() => expect(sent).toEqual(["first second"]));
    // end() is terminal: a late delta or second end must not double-send.
    painter.delta(" late");
    painter.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual(["first second"]);
});

test("framePainter routes deltas to one painter per automation and surfaces failures", async () => {
    const made: string[] = [];
    const painters = new Map<string, { deltas: string[]; ended: boolean }>();
    const failures: string[] = [];
    const paint = framePainter(
        (automationId) => {
            made.push(automationId);
            const record = { deltas: [] as string[], ended: false };
            painters.set(automationId, record);
            const painter: Painter = { delta: (text) => record.deltas.push(text), end: () => (record.ended = true) };
            return painter;
        },
        (reason) => failures.push(reason),
    );
    paint({ automationId: "a", delta: "one" });
    paint({ automationId: "b", delta: "two" });
    paint({ automationId: "a", delta: " more" });
    paint({ automationId: "a", failed: "usage limit reached" });
    paint({ automationId: "a", end: true });
    // One painter per automation, reused across frames: two automations answering one mention don't share.
    expect(made).toEqual(["a", "b"]);
    expect(painters.get("a")).toEqual({ deltas: ["one", " more"], ended: true });
    expect(painters.get("b")).toEqual({ deltas: ["two"], ended: false });
    expect(failures).toEqual(["usage limit reached"]);
});
