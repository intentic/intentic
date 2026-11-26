// The backend's log lines, in the shape the fix agent's code wrote them while it was the daemon's (pino's `(fields,
// message)`), said through `api.log`, which attributes each to this extension in the daemon's own log. An error rides as
// its message (`err: errorMessage(error)`).

type LogValue = string | number | boolean | readonly (string | number)[] | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
    readonly info: (fields: LogFields, message: string) => void;
    readonly warn: (fields: LogFields, message: string) => void;
}

const lineOf = (level: "info" | "warn", fields: LogFields, message: string): string => {
    const said = Object.entries(fields).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${JSON.stringify(value)}`]));
    return [level === "info" ? message : `warn: ${message}`, ...said].join(" ");
};

export const loggerOf = (log: (message: string) => void): Logger => ({
    info: (fields, message) => log(lineOf("info", fields, message)),
    warn: (fields, message) => log(lineOf("warn", fields, message)),
});
