import { readFile } from "node:fs/promises";
import { plural } from "@intentic/base/format";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* V8 profiles (node --cpu-prof, --heap-prof, DevTools): a sample tree whose reading is a ranked table, not the JSON. */

const TOP_ROWS = 25;

interface CallFrame {
    readonly functionName?: string;
    readonly url?: string;
    readonly lineNumber?: number;
}

// --cpu-prof: a flat node list, each sample naming the node that was on top of the stack.
interface CpuNode {
    readonly id: number;
    readonly callFrame: CallFrame;
    readonly children?: readonly number[];
}

interface CpuProfile {
    readonly nodes: readonly CpuNode[];
    readonly startTime: number;
    readonly endTime: number;
    readonly samples?: readonly number[];
    readonly timeDeltas?: readonly number[];
}

// --heap-prof: a tree of allocation sites, each with the bytes sampled as allocated there.
interface HeapNode {
    readonly callFrame: CallFrame;
    readonly selfSize: number;
    readonly children?: readonly HeapNode[];
}

interface HeapProfile {
    readonly head: HeapNode;
}

interface Row {
    readonly key: string;
    self: number;
    total: number;
}

// One function across every node it appears at: V8 splits a function into a node per distinct caller path.
const keyOf = (frame: CallFrame): string => {
    const name = frame.functionName === undefined || frame.functionName === "" ? "(anonymous)" : frame.functionName;
    if (frame.url === undefined || frame.url === "") {
        return name;
    }
    // Line numbers are 0-based in the profile and 1-based everywhere a person or an editor reads them.
    const file = frame.url.replace(/^file:\/\//u, "");
    return `${name} ${file}:${String((frame.lineNumber ?? 0) + 1)}`;
};

const rowOf = (rows: Map<string, Row>, key: string): Row => {
    const existing = rows.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const row: Row = { key, self: 0, total: 0 };
    rows.set(key, row);
    return row;
};

const percent = (part: number, whole: number): string => (whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`);

const table = (heading: string, unit: (value: number) => string, rows: readonly Row[], whole: number): string =>
    [
        `## ${heading}`,
        "",
        "| self | self % | total | total % | function |",
        "| ---: | ---: | ---: | ---: | --- |",
        ...rows.map((row) => `| ${unit(row.self)} | ${percent(row.self, whole)} | ${unit(row.total)} | ${percent(row.total, whole)} | \`${row.key.replaceAll("|", "\\|")}\` |`),
    ].join("\n");

const ranked = (rows: Map<string, Row>, by: "self" | "total"): readonly Row[] => [...rows.values()].toSorted((left, right) => right[by] - left[by]).slice(0, TOP_ROWS);

const milliseconds = (microseconds: number): string => `${(microseconds / 1_000).toFixed(1)} ms`;

const kilobytes = (bytes: number): string => `${(bytes / 1_024).toFixed(1)} KB`;

// Sample i's duration is the gap to the next sample; the last one takes the mean, since nothing follows it.
const cpuDoc = (profile: CpuProfile): DerivedDoc => {
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    const parent = new Map<number, number>();
    const byId = new Map<number, CpuNode>();
    for (const node of profile.nodes) {
        byId.set(node.id, node);
        for (const child of node.children ?? []) {
            parent.set(child, node.id);
        }
    }
    const span = profile.endTime - profile.startTime;
    const meanGap = samples.length === 0 ? 0 : span / samples.length;
    const rows = new Map<string, Row>();
    for (const [index, id] of samples.entries()) {
        const duration = deltas[index + 1] ?? meanGap;
        const top = byId.get(id);
        if (top === undefined) {
            continue;
        }
        rowOf(rows, keyOf(top.callFrame)).self += duration;
        // Inclusive time counts a function once per sample, however deep it recurses.
        const onStack = new Set<string>();
        for (let node: number | undefined = id; node !== undefined; node = parent.get(node)) {
            const frame = byId.get(node)?.callFrame;
            if (frame !== undefined && frame.functionName !== "(root)") {
                onStack.add(keyOf(frame));
            }
        }
        for (const key of onStack) {
            rowOf(rows, key).total += duration;
        }
    }
    const notes = samples.length === 0 ? ["no samples in this profile: it recorded nothing, or ran shorter than one sampling interval"] : [];
    if (rows.size > TOP_ROWS) {
        notes.push(`${plural(rows.size, "function")} sampled; each table shows the top ${String(TOP_ROWS)}`);
    }
    return {
        title: `CPU profile: ${milliseconds(span)} over ${plural(samples.length, "sample")}`,
        markdown: [table("By self time", milliseconds, ranked(rows, "self"), span), table("By total time", milliseconds, ranked(rows, "total"), span)].join("\n\n"),
        notes,
    };
};

const heapDoc = (profile: HeapProfile): DerivedDoc => {
    const rows = new Map<string, Row>();
    // Returns the subtree's bytes; a function's total counts each path through it once, recursion included.
    const walk = (node: HeapNode, ancestors: ReadonlySet<string>): number => {
        const key = keyOf(node.callFrame);
        const isRoot = node.callFrame.functionName === "(root)";
        const inside = isRoot || ancestors.has(key) ? ancestors : new Set([...ancestors, key]);
        const below = (node.children ?? []).reduce((sum, child) => sum + walk(child, inside), 0);
        if (!isRoot) {
            const row = rowOf(rows, key);
            row.self += node.selfSize;
            if (!ancestors.has(key)) {
                row.total += node.selfSize + below;
            }
        }
        return node.selfSize + below;
    };
    const whole = walk(profile.head, new Set());
    const notes = whole === 0 ? ["no allocations sampled in this profile"] : [];
    if (rows.size > TOP_ROWS) {
        notes.push(`${plural(rows.size, "allocation site")} sampled; each table shows the top ${String(TOP_ROWS)}`);
    }
    return {
        title: `Heap profile: ${kilobytes(whole)} sampled as allocated`,
        markdown: [table("By bytes allocated here", kilobytes, ranked(rows, "self"), whole), table("By bytes allocated here and below", kilobytes, ranked(rows, "total"), whole)].join("\n\n"),
        notes,
    };
};

export const profileDeriver: Deriver = {
    name: "profile",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const profile = JSON.parse(await readFile(absPath, "utf8")) as Partial<CpuProfile & HeapProfile>;
        if (Array.isArray(profile.nodes) && typeof profile.startTime === "number" && typeof profile.endTime === "number") {
            return cpuDoc(profile as CpuProfile);
        }
        if (profile.head !== undefined) {
            return heapDoc(profile as HeapProfile);
        }
        return { markdown: "", notes: ["not a V8 CPU or heap profile: neither `nodes` with start and end times, nor a `head` node"] };
    },
};
