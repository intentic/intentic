import type { AgentEvent } from "@intentic/sandbox-contract";
import { type DocumentScan, namedDocumentPaths, withProducedDocuments } from "./produced-documents.js";

/* A finished command's documents onto its card: which calls are asked about, what the scan is told, and where the
   update lands in the turn's frames. The scan itself stands in; the disk half is produced-documents.integration.test.ts. */

async function* framesOf(events: readonly AgentEvent[]): AsyncGenerator<AgentEvent> {
    for (const event of events) {
        yield event;
    }
}

const collect = async (frames: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const seen: AgentEvent[] = [];
    for await (const frame of frames) {
        seen.push(frame);
    }
    return seen;
};

// A scan answering `paths` for every question, recording what it was asked.
const scanning = (paths: readonly string[]) => {
    const asked: { since: number; named: readonly string[] }[] = [];
    const scan: DocumentScan = async (since, named) => {
        asked.push({ since, named });
        return paths;
    };
    return { scan, asked };
};

const bash = (id: string, command: string, locations?: { path: string }[]): AgentEvent => {
    const call: Extract<AgentEvent, { kind: "tool_call" }> = { kind: "tool_call", id, name: "Bash", category: "execute", status: "in_progress", target: command };
    if (locations !== undefined) {
        call.locations = locations;
    }
    return call;
};
const finished = (id: string, output: string): AgentEvent => ({ kind: "tool_call_update", id, status: "completed", content: [{ type: "text", text: output }] });
const DONE: AgentEvent = { kind: "done" };

describe("withProducedDocuments", () => {
    test("a command that wrote a deck gets it named on its card, before the turn's done", async () => {
        const { scan, asked } = scanning(["out/q3-deck.pptx"]);
        const frames = await collect(
            withProducedDocuments(framesOf([bash("b1", "python make_deck.py"), finished("b1", "Saved the deck."), DONE]), scan, () => 50_000),
        );
        expect(frames).toEqual([
            bash("b1", "python make_deck.py"),
            finished("b1", "Saved the deck."),
            { kind: "tool_call_update", id: "b1", locations: [{ path: "out/q3-deck.pptx" }] },
            DONE,
        ]);
        // The window opens a second before the call was seen; the command and what it printed are both searched.
        expect(asked).toEqual([{ since: 49_000, named: ["python make_deck.py", "Saved the deck."] }]);
    });

    test("the update keeps what the card already named, and names nothing twice", async () => {
        const { scan } = scanning(["notes/report.pdf", "src/page.html"]);
        const opened = bash("b1", "make", [{ path: "src/page.html" }]);
        const frames = await collect(withProducedDocuments(framesOf([opened, finished("b1", ""), DONE]), scan));
        expect(frames.at(-2)).toEqual({ kind: "tool_call_update", id: "b1", locations: [{ path: "src/page.html" }, { path: "notes/report.pdf" }] });
    });

    test("a failed command is asked about too: the script may have written its file before it fell over", async () => {
        const { scan } = scanning(["deck.pptx"]);
        const failed: AgentEvent = { kind: "tool_call_update", id: "b1", status: "failed" };
        const frames = await collect(withProducedDocuments(framesOf([bash("b1", "python deck.py"), failed, DONE]), scan));
        expect(frames.map((frame) => frame.kind)).toEqual(["tool_call", "tool_call_update", "tool_call_update", "done"]);
    });

    test("a command that wrote nothing adds no frame, and an edit or a read is never asked about", async () => {
        const quiet = scanning([]);
        const events: AgentEvent[] = [
            bash("b1", "ls"),
            { kind: "tool_call", id: "e1", name: "Write", category: "edit", status: "in_progress", locations: [{ path: "a.html" }] },
            { kind: "tool_call_update", id: "e1", status: "completed" },
            { kind: "tool_call", id: "r1", name: "Read", category: "read", status: "in_progress" },
            { kind: "tool_call_update", id: "r1", status: "completed" },
            finished("b1", "a.html"),
            DONE,
        ];
        expect(await collect(withProducedDocuments(framesOf(events), quiet.scan))).toEqual(events);
        expect(quiet.asked).toHaveLength(1);
    });

    test("a call reported only once it had finished has no start to measure from, so nothing is attributed to it", async () => {
        const { scan, asked } = scanning(["deck.pptx"]);
        const whole: AgentEvent = { kind: "tool_call", id: "b1", name: "Bash", category: "execute", status: "completed", target: "python deck.py" };
        expect(await collect(withProducedDocuments(framesOf([whole, DONE]), scan))).toEqual([whole, DONE]);
        expect(asked).toEqual([]);
    });

    test("an interim update is not the end: only a settled status asks, with the output as it last stood", async () => {
        const { scan, asked } = scanning([]);
        const interim: AgentEvent = { kind: "tool_call_update", id: "b1", content: [{ type: "text", text: "rendering…" }] };
        await collect(withProducedDocuments(framesOf([bash("b1", "render"), interim, { kind: "tool_call_update", id: "b1", status: "completed" }, DONE]), scan));
        expect(asked.map((ask) => ask.named)).toEqual([["render", "rendering…"]]);
    });

    test("a scan that answers late is still sent before the stream ends when the runtime sends no done", async () => {
        let answer: (paths: readonly string[]) => void = () => {};
        const scan: DocumentScan = () => new Promise((resolve) => (answer = resolve));
        const run = collect(withProducedDocuments(framesOf([bash("b1", "x"), finished("b1", "")]), scan));
        await new Promise((resolve) => setTimeout(resolve, 5));
        answer(["x.docx"]);
        expect((await run).at(-1)).toEqual({ kind: "tool_call_update", id: "b1", locations: [{ path: "x.docx" }] });
    });
});

describe("namedDocumentPaths", () => {
    test("finds a deliverable however a command or its output spells it", () => {
        expect(
            namedDocumentPaths(`soffice --convert-to pdf --outdir out "q3/Board Deck.pptx" && pandoc notes.md -o=site/index.html; echo Saved: report.DOCX.`),
        ).toEqual(["Deck.pptx", "site/index.html", "report.DOCX"]);
    });

    test("a URL is not a file, a home path is not the workspace's, and source is no deliverable", () => {
        expect(namedDocumentPaths(`curl -o /tmp/a.bin https://example.com/files/spec.pdf ~/Downloads/b.pdf src/app.ts page.html5`)).toEqual([]);
    });
});
