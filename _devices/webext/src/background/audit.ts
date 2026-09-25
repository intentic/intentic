import { describeCall } from "./activity.js";
import { store } from "./store.js";

/* WHAT THE PERSON CAN SEE AFTERWARDS. */

export const record = async (tool: string, args: Record<string, unknown>, ok: boolean, note?: string): Promise<void> => {
    await store.append({ at: Date.now(), tool, detail: describeCall(tool, args), ok, ...(note === undefined ? {} : { note: note.slice(0, 240) }) });
};
