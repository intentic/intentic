import { HANDOVER_TEXT, HANDOVER_TEXT_BEFORE } from "../../fixture/document";
import type { Doors } from "../doors";

// One version of the document as the text a daemon's fileq would render from it (the diff's Text reading).
const derivedSide = (content: string) => ({ present: true as const, content, deriver: `docx v2`, notes: [], truncated: false });

export const diffDoors = {
    derived: () => ({ before: derivedSide(HANDOVER_TEXT_BEFORE), after: derivedSide(HANDOVER_TEXT) }),
} satisfies Doors<`diff`>;
