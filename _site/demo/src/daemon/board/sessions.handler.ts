import { searchSessions } from "./cards";
import type { Doors } from "../doors";

export const sessionsDoors = {
    list: ({ query = ``, caseSensitive }) => ({ sessions: searchSessions(query, caseSensitive === true) }),
    get: () => ({ messages: [] }),
} satisfies Doors<`sessions`>;
