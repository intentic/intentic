import { store } from "./store.js";

/* WHAT THE PERSON CAN SEE AFTERWARDS. */
export const record = async (tool: string, args: Record<string, unknown>, ok: boolean, note?: string): Promise<void> => {
    const redacted = tool === "fill" ? { ...args, text: `<${String(args["text"] ?? "").length} characters>` } : args;
    const detail = `${JSON.stringify(redacted).slice(0, 300)}${note === undefined ? "" : ` — ${note.slice(0, 160)}`}`;
    await store.append({ at: Date.now(), tool, detail, ok });
};
