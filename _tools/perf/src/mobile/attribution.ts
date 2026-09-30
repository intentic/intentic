import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Where a phone's CPU time went, by source: a V8 CPU profile's self time per sample, walked back through the build's
// sourcemaps to the file (and the package) that code came from. A profile of a minified bundle names `n`, `Ye` and
// `index-D0P5VUoY.js:1`; this is what turned "the chat is slow" into "a quarter of it is `getBoundingClientRect` in
// ChatMessageView.vue:309".

// V8's CPU profile, as `Profiler.stop` returns it.
export interface CpuProfile {
    readonly nodes: readonly {
        readonly id: number;
        readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number; readonly columnNumber: number };
    }[];
    readonly samples?: readonly number[];
    readonly timeDeltas?: readonly number[];
}

const BASE64 = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/`;

/** One segment's fields, decoded from base64 VLQ: relative values, as the format stores them. */
export const decodeVlq = (segment: string): number[] => {
    const values: number[] = [];
    let shift = 0;
    let value = 0;
    for (const char of segment) {
        let digit = BASE64.indexOf(char);
        const more = (digit & 32) !== 0;
        digit &= 31;
        value += digit << shift;
        if (more) {
            shift += 5;
            continue;
        }
        const negative = (value & 1) === 1;
        value >>>= 1;
        values.push(negative ? -value : value);
        value = 0;
        shift = 0;
    }
    return values;
};

interface Mapping {
    readonly column: number;
    readonly source: number;
    readonly line: number;
    readonly name: number;
}

/** A sourcemap read into per-line mappings, answering which source a generated position came from. */
export class SourceMap {
    private readonly lines: Mapping[][] = [];

    constructor(
        readonly sources: readonly string[],
        readonly names: readonly string[],
        mappings: string,
    ) {
        // Source index, source line and name index accumulate across the whole map; the source column is not needed here.
        let source = 0;
        let line = 0;
        let name = 0;
        for (const text of mappings.split(`;`)) {
            const decoded: Mapping[] = [];
            let generated = 0;
            for (const segment of text === `` ? [] : text.split(`,`)) {
                const fields = decodeVlq(segment);
                generated += fields[0] ?? 0;
                if (fields.length >= 4) {
                    source += fields[1] ?? 0;
                    line += fields[2] ?? 0;
                    if (fields.length >= 5) {
                        name += fields[4] ?? 0;
                    }
                    decoded.push({ column: generated, source, line, name: fields.length >= 5 ? name : -1 });
                }
            }
            this.lines.push(decoded);
        }
    }

    /** The source position a generated one (zero-based line and column) maps back to, or undefined. */
    lookup(line: number, column: number): { readonly source: string; readonly line: number; readonly name: string | undefined } | undefined {
        const segments = this.lines[line];
        if (segments === undefined || segments.length === 0) {
            return undefined;
        }
        let low = 0;
        let high = segments.length - 1;
        let found: Mapping | undefined;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const segment = segments[middle]!;
            if (segment.column <= column) {
                found = segment;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (found === undefined) {
            return undefined;
        }
        const source = this.sources[found.source];
        return source === undefined ? undefined : { source, line: found.line + 1, name: found.name >= 0 ? this.names[found.name] : undefined };
    }

    static read(path: string): SourceMap | undefined {
        if (!existsSync(path)) {
            return undefined;
        }
        // SAFETY: the map is one the build under measure wrote beside its chunk, in the sourcemap v3 format.
        const map = JSON.parse(readFileSync(path, `utf8`)) as { sources: string[]; names?: string[]; mappings: string };
        return new SourceMap(map.sources, map.names ?? [], map.mappings);
    }
}

/** A source path reduced to what it belongs to: an npm package, or a repository area two levels deep. */
export const areaOf = (source: string): string => {
    const npm = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/u.exec(source);
    if (npm !== null) {
        return `npm:${npm[1]}`;
    }
    const area = /(_editor\/[^/]+\/src\/[^/]+\/[^/]+|_shared\/[^/]+|_tools\/[^/]+|_extensions\/[^/]+|_site\/demo\/[^/]+)/u.exec(source);
    return area?.[1] ?? source.replace(/^(?:\.\.\/)+/u, ``);
};

export interface Attribution {
    readonly totalMs: number;
    readonly idleMs: number;
    /** Time outside JavaScript: parsing, style, layout, paint and the rest of the engine's own work. */
    readonly engineMs: number;
    readonly byArea: readonly (readonly [area: string, ms: number])[];
    readonly byFunction: readonly (readonly [where: string, ms: number])[];
}

type Frame = CpuProfile["nodes"][number]["callFrame"];

/** Where one frame's time is counted. */
interface Place {
    /** Its package or repository folder. */
    readonly area: string;
    /** Its function, by source file and line where the build has a map for it. */
    readonly where: string;
}

const placeOf = (frame: Frame, mapOf: (url: string) => SourceMap | undefined): Place => {
    const name = frame.functionName === `` ? `(anonymous)` : frame.functionName;
    if (frame.url === ``) {
        return { area: name, where: name };
    }
    const position = mapOf(frame.url)?.lookup(frame.lineNumber, frame.columnNumber);
    if (position === undefined) {
        const file = frame.url.split(`/`).pop() ?? frame.url;
        return { area: file, where: `${file} ${frame.functionName}` };
    }
    return { area: areaOf(position.source), where: `${position.source.replace(/^(?:\.\.\/)+/u, ``)}:${position.line} ${position.name ?? frame.functionName}` };
};

const add = (totals: Map<string, number>, key: string, micros: number): void => {
    totals.set(key, (totals.get(key) ?? 0) + micros);
};

const ms = (micros: number): number => Math.round(micros / 1000);

/** Self time per area and per function, heaviest first, read against the sourcemaps in `assets`. */
export const attribute = (profile: CpuProfile, assets: string, top = 20): Attribution => {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const deltas = profile.timeDeltas ?? [];
    const self = new Map<number, number>();
    (profile.samples ?? []).forEach((sample, index) => self.set(sample, (self.get(sample) ?? 0) + (deltas[index] ?? 0)));
    const maps = new Map<string, SourceMap | undefined>();
    const mapOf = (url: string): SourceMap | undefined => {
        const file = url.split(`/`).pop()?.split(`?`)[0] ?? ``;
        if (!maps.has(file)) {
            maps.set(file, file === `` ? undefined : SourceMap.read(join(assets, `${file}.map`)));
        }
        return maps.get(file);
    };
    const areas = new Map<string, number>();
    const functions = new Map<string, number>();
    let total = 0;
    for (const [id, micros] of self) {
        const frame = nodes.get(id)?.callFrame;
        if (frame !== undefined) {
            total += micros;
            const { area, where } = placeOf(frame, mapOf);
            add(areas, area, micros);
            add(functions, where, micros);
        }
    }
    const ranked = (totals: Map<string, number>): (readonly [string, number])[] =>
        [...totals.entries()]
            .filter(([key]) => key !== `(idle)` && key !== `(program)`)
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, top)
            .map(([key, micros]) => [key, ms(micros)] as const);
    return {
        totalMs: ms(total),
        idleMs: ms(areas.get(`(idle)`) ?? 0),
        engineMs: ms(areas.get(`(program)`) ?? 0),
        byArea: ranked(areas),
        byFunction: ranked(functions),
    };
};
