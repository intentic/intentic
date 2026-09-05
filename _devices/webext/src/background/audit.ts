import { store } from "./store.js";

/* WHAT THE PERSON CAN SEE AFTERWARDS. Every tool call lands here, and the popup renders it newest-first.
 *
 * The redaction rule is the same one the host agent's audit log follows, and it is the line that makes a log
 * worth keeping: arguments verbatim EXCEPT typed text. `fill` carries whatever was entered into a page, which
 * is routinely a password, a message or a card number, and writing it to a file on somebody's disk is the one
 * thing an audit trail must not do to earn its place. Its LENGTH still tells the story a reader needs —
 * "typed 24 characters into e3" — without becoming a second copy of the secret.
 *
 * A key press is not redacted: "Escape" is the fact, and there is nothing in it to leak. */
export const record = async (tool: string, args: Record<string, unknown>, ok: boolean, note?: string): Promise<void> => {
    const redacted = tool === "fill" ? { ...args, text: `<${String(args["text"] ?? "").length} characters>` } : args;
    const detail = `${JSON.stringify(redacted).slice(0, 300)}${note === undefined ? "" : ` — ${note.slice(0, 160)}`}`;
    await store.append({ at: Date.now(), tool, detail, ok });
};
