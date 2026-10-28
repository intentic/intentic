import { describeCall } from "./activity.js";
import { type SandboxKey, store } from "./store.js";

/* WHAT THE PERSON CAN SEE AFTERWARDS. */

export const record = async (from: SandboxKey, tool: string, args: Record<string, unknown>, ok: boolean, note?: string): Promise<void> => {
    await store.append({
        at: Date.now(),
        tool,
        detail: describeCall(tool, args),
        ok,
        sandbox: from,
        ...(note === undefined ? {} : { note: note.slice(0, 240) }),
    });
};
