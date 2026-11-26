import type { JsonValue } from "@intentic/base/json";
import { array, type ZodType } from "zod";

// A list a kit keeps between calls in one JSON value its host stores: newest first, and only the newest `keep`. An
// entry that does not read (a build that kept another shape) is dropped rather than failing the call.
export const keptList = <Entry extends JsonValue>(
    read: () => Promise<JsonValue | undefined>,
    write: (value: JsonValue) => Promise<void>,
    entry: ZodType<Entry>,
    keep: number,
) => {
    const listed = array(entry.nullable().catch(null));
    const list = async (): Promise<Entry[]> => {
        const parsed = listed.safeParse(await read());
        return parsed.success ? parsed.data.filter((kept): kept is Entry => kept !== null) : [];
    };
    return {
        list,
        // Puts `kept` first, replacing an entry `same` matches. Answers the entries that fell off the end, whose pages the
        // kit then lets go.
        put: async (kept: Entry, same: (other: Entry) => boolean): Promise<Entry[]> => {
            const all = [kept, ...(await list()).filter((other) => !same(other))];
            await write(all.slice(0, keep));
            return all.slice(keep);
        },
    };
};
