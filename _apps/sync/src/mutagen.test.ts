import { describe, expect, it } from "vitest";
import { forwardSessionName, parseForwardNames } from "./mutagen.js";

// What `forward list` hands back decides what gets terminated, so this filter is the line between "retire the
// forwards this agent left behind" and "terminate the user's own Mutagen sessions". Names are whitespace-free
// by construction (a sanitized sandbox id plus a port), which is what makes splitting on whitespace safe.
describe("parseForwardNames", () => {
    it("keeps every session under this agent's prefix and nothing else", () => {
        expect(parseForwardNames("intentic-fwd-sandbox-a-5173 someone-elses-forward intentic-fwd-sandbox-b-6480\n")).toEqual([
            "intentic-fwd-sandbox-a-5173",
            "intentic-fwd-sandbox-b-6480",
        ]);
    });

    it("reads an empty list as nothing to retire", () => {
        expect(parseForwardNames("")).toEqual([]);
        expect(parseForwardNames("  \n ")).toEqual([]);
    });

    it("matches what forwardSessionName produces, for any sandbox", () => {
        const names = [forwardSessionName("sandbox-old.example.dev", 5173), forwardSessionName("sandbox-new.example.dev", 6480)];
        expect(parseForwardNames(`${names.join(" ")} mutagen-something-else`)).toEqual(names);
    });
});
