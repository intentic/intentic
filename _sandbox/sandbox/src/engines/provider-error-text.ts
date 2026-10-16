// A provider's refusal as a person reads it. Routed providers answer with a JSON error body, and the CLI in front of
// them prints it whole ("API Error: 404 {"error":{"code":"model_not_found","message":"…"}}"), which the board then showed
// as a failed card's only line. The body is replaced by the message it carries, its code kept in brackets; text that
// holds no such body comes back unchanged. Applied only to what is shown: classification reads the raw words first.

interface Said {
    readonly message: string | undefined;
    readonly code: string | undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

// `{error: {message, code|type}}`, `{error: "…"}`, or `{message, code}`, the shapes the vendors in front of us use.
const saidBy = (body: unknown): Said | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const record = body as Record<string, unknown>;
    const inner = record["error"];
    if (typeof inner === "string") {
        return { message: text(inner), code: text(record["code"]) };
    }
    const error = typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : record;
    const code = text(error["code"]) ?? text(error["type"]) ?? text(error["status"]);
    const said = { message: text(error["message"]), code };
    return said.message === undefined && said.code === undefined ? undefined : said;
};

export const readableProviderText = (raw: string): string => {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) {
        return raw;
    }
    let body: unknown;
    try {
        body = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return raw;
    }
    const said = saidBy(body);
    if (said === undefined) {
        return raw;
    }
    // A code alone still reads better as words than as a JSON key: `model_not_found` is "model not found".
    const message = said.message ?? (said.code ?? "").replace(/[_-]+/g, " ");
    const code = said.message !== undefined && said.code !== undefined ? ` (${said.code})` : "";
    const before = raw.slice(0, start).trim();
    const after = raw.slice(end + 1).trim();
    return [before, `${message}${code}`, after].filter((part) => part !== "").join(" ");
};
