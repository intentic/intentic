import { oneLine } from "@intentic/base/one-line";
import { TITLE_MAX } from "../../seams/conversation-title.js";
import type { PersistedAgent } from "./agents-store.js";

// A home is a person's standing conversation, not the job their first message described. Derive its name wherever an
// entry enters the fleet, including older homes with model or plan titles. A person's explicit rename always stands.
export const withHomeTitle = (entry: PersistedAgent): PersistedAgent => {
    if (entry.identity.home !== true || entry.social.title?.source === "user") {
        return entry;
    }
    const owner = entry.social.owner;
    const who = owner?.name?.trim() || owner?.email;
    const text = oneLine(who === undefined ? "Home" : `Home · ${who}`, TITLE_MAX, { ellipsis: false });
    return { ...entry, social: { ...entry.social, title: { text, source: "derived" } } };
};
