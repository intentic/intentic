import type { CdpParams } from "./cdp.js";

// THE PAGE'S CONSOLE, AS THE AGENT READS IT (2026-11-03). A game that renders black squares on one GPU says why in its
// console (a WebGPU validation error, a lost device, a shader that failed to compile) and nowhere else. The session
// enables the Runtime and Log domains when it attaches; Chrome then replays what the page already logged (V8 keeps the
// last thousand messages) and streams the rest, and each event is turned into one entry here. Agents in the shinobi
// sandbox hand-built raw CDP clients in /tmp to read exactly this.

export type ConsoleLevel = "error" | "warning" | "info" | "log" | "debug";

export interface ConsoleEntry {
    // Milliseconds since the epoch, as the browser stamped it.
    readonly at: number;
    readonly level: ConsoleLevel;
    // `console` (the page's own console.* calls), `exception` (an uncaught error or rejection), `page` (a navigation),
    // or the browser's own source for what it logged itself (`network`, `security`, `rendering`, `intervention`, …).
    readonly source: string;
    readonly text: string;
    // `url:line` of the call or the error, when the browser named one.
    readonly where: string | undefined;
}

// The most entries kept; older ones are dropped and counted, so a page that logs every frame cannot grow the agent.
export const CONSOLE_CAP = 1000;
// The longest one entry's text may be: a logged object graph or a minified stack is cut, and says so.
const MAX_ENTRY_TEXT = 2000;

// The subset of a CDP RemoteObject a console argument is rendered from.
interface RemoteValue {
    readonly type?: string;
    readonly subtype?: string;
    readonly value?: unknown;
    readonly unserializableValue?: string;
    readonly description?: string;
    readonly preview?: { readonly properties?: readonly { readonly name: string; readonly value?: string; readonly type?: string }[]; readonly overflow?: boolean };
}

interface CallFrame {
    readonly url?: string;
    readonly lineNumber?: number;
}

const cut = (text: string): string => (text.length <= MAX_ENTRY_TEXT ? text : `${text.slice(0, MAX_ENTRY_TEXT)}… (${text.length - MAX_ENTRY_TEXT} more characters)`);

// `url:line`, one-based as a person reads it (CDP counts lines from zero).
const placeOf = (url: string | undefined, line: number | undefined): string | undefined =>
    url === undefined || url === "" ? undefined : line === undefined ? url : `${url}:${line + 1}`;

const previewOf = (arg: RemoteValue): string | undefined => {
    const properties = arg.preview?.properties;
    if (properties === undefined) {
        return undefined;
    }
    const shown = properties.map((property) => `${property.name}: ${property.type === "string" ? JSON.stringify(property.value ?? "") : (property.value ?? "")}`);
    const more = arg.preview?.overflow === true ? ", …" : "";
    return arg.subtype === "array" ? `[${properties.map((property) => property.value ?? "").join(", ")}${more}]` : `{${shown.join(", ")}${more}}`;
};

// One console argument as text: a primitive as itself, an object by its preview, else by what the browser calls it.
const argText = (arg: RemoteValue): string => {
    if (arg.type === "undefined") {
        return "undefined";
    }
    if (arg.unserializableValue !== undefined) {
        return arg.unserializableValue;
    }
    if (arg.type === "string") {
        return String(arg.value);
    }
    if (arg.type === "number" || arg.type === "boolean") {
        return String(arg.value);
    }
    if (arg.subtype === "null") {
        return "null";
    }
    // An Error's description is its stack, which is what the agent needs; any other object reads best by its preview.
    if (arg.subtype === "error") {
        return arg.description ?? "Error";
    }
    return previewOf(arg) ?? arg.description ?? arg.type ?? "?";
};

// console.log's own format directives in a first string argument: %s %d %i %f %o %O take the next argument, %c takes
// one and shows nothing (it is CSS), %% is a percent sign. The rest are joined with spaces, as the console shows them.
export const formatArgs = (args: readonly RemoteValue[]): string => {
    const [first, ...rest] = args;
    if (first === undefined) {
        return "";
    }
    if (first.type !== "string") {
        return args.map(argText).join(" ");
    }
    let next = 0;
    const head = String(first.value).replace(/%([sdifoOc%])/g, (whole, directive: string) => {
        if (directive === "%") {
            return "%";
        }
        const arg = rest[next];
        if (arg === undefined) {
            return whole;
        }
        next += 1;
        return directive === "c" ? "" : argText(arg);
    });
    return [head, ...rest.slice(next).map(argText)].join(" ");
};

const levelOfCall = (type: string): ConsoleLevel => {
    if (type === "error" || type === "assert") {
        return "error";
    }
    if (type === "warning") {
        return "warning";
    }
    if (type === "info" || type === "debug") {
        return type;
    }
    return "log";
};

const levelOfLog = (level: string): ConsoleLevel => (level === "error" || level === "warning" || level === "info" ? level : "debug");

// The three events that carry a console entry, in the protocol's own shapes; every field is read as optional.
interface ConsoleCall {
    readonly type?: string;
    readonly args?: readonly RemoteValue[];
    readonly timestamp?: number;
    readonly stackTrace?: { readonly callFrames?: readonly CallFrame[] };
}
interface ExceptionThrown {
    readonly timestamp?: number;
    readonly exceptionDetails?: {
        readonly text?: string;
        readonly url?: string;
        readonly lineNumber?: number;
        readonly exception?: RemoteValue;
        readonly stackTrace?: { readonly callFrames?: readonly CallFrame[] };
    };
}
interface LogEntryAdded {
    readonly entry?: { readonly source?: string; readonly level?: string; readonly text?: string; readonly url?: string; readonly lineNumber?: number; readonly timestamp?: number };
}

const fromCall = (call: ConsoleCall, now: number): ConsoleEntry => {
    const frame = call.stackTrace?.callFrames?.[0];
    return {
        at: call.timestamp ?? now,
        level: levelOfCall(call.type ?? "log"),
        source: "console",
        text: cut(formatArgs(call.args ?? [])),
        where: placeOf(frame?.url, frame?.lineNumber),
    };
};

const fromException = (thrown: ExceptionThrown, now: number): ConsoleEntry => {
    const details = thrown.exceptionDetails ?? {};
    const frame = details.stackTrace?.callFrames?.[0];
    // "Uncaught" alone is the browser's prefix; the exception's own description carries the message and its stack.
    const described = details.exception === undefined ? undefined : argText(details.exception);
    const text = [details.text, described].filter((part): part is string => part !== undefined && part !== "").join(" ");
    return {
        at: thrown.timestamp ?? now,
        level: "error",
        source: "exception",
        text: cut(text === "" ? "An uncaught error." : text),
        where: placeOf(details.url ?? frame?.url, details.lineNumber ?? frame?.lineNumber),
    };
};

const fromLog = ({ entry }: LogEntryAdded, now: number): ConsoleEntry | undefined =>
    entry === undefined
        ? undefined
        : {
              at: entry.timestamp ?? now,
              level: levelOfLog(entry.level ?? "verbose"),
              source: entry.source ?? "browser",
              text: cut(entry.text ?? ""),
              where: placeOf(entry.url, entry.lineNumber),
          };

// One CDP event as a console entry, or undefined for an event that is not one. `now` stamps an event the browser did not.
export const consoleEntryOf = (method: string, params: CdpParams, now: number = Date.now()): ConsoleEntry | undefined => {
    switch (method) {
        case "Runtime.consoleAPICalled":
            // SAFETY: the protocol's own shape for this event, every field optional.
            return fromCall(params as ConsoleCall, now);
        case "Runtime.exceptionThrown":
            // SAFETY: as above.
            return fromException(params as ExceptionThrown, now);
        case "Log.entryAdded":
            // SAFETY: as above.
            return fromLog(params as LogEntryAdded, now);
        // Every context of the page went away at once: it navigated or reloaded. What follows is the new document's.
        case "Runtime.executionContextsCleared":
            return { at: now, level: "info", source: "page", text: "The page navigated or reloaded: what follows is the new document's.", where: undefined };
        default:
            return undefined;
    }
};

export interface ConsoleRead {
    readonly entries: readonly ConsoleEntry[];
    // How many older entries were let go to keep CONSOLE_CAP.
    readonly dropped: number;
}

// What a session has collected: the newest CONSOLE_CAP entries, and how many older ones were let go.
export class ConsoleLog {
    #entries: ConsoleEntry[] = [];
    #dropped = 0;

    add(entry: ConsoleEntry): void {
        this.#entries.push(entry);
        if (this.#entries.length > CONSOLE_CAP) {
            this.#entries.shift();
            this.#dropped += 1;
        }
    }

    // A CDP event, kept when it is a console entry.
    take(method: string, params: CdpParams): void {
        const entry = consoleEntryOf(method, params);
        if (entry !== undefined) {
            this.add(entry);
        }
    }

    read(): ConsoleRead {
        return { entries: [...this.#entries], dropped: this.#dropped };
    }
}
