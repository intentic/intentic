import { describe, expect, it } from "vitest";
import { deskAllowedPath } from "./deskPaths";

// The prefixes a desk may stand on, and the ones the shell sends it home from: pinned so a new route lands on the
// refused side by default.
describe(`deskAllowedPath`, () => {
    it(`admits the chat, the board of its own conversations, its settings, and the access section`, () => {
        for (const path of [`/chat`, `/chat/abc`, `/agents`, `/agents/abc`, `/agent/abc`, `/settings`, `/settings/appearance`, `/sandbox/access`, `/floating/chat`]) {
            expect(deskAllowedPath(path), path).toBe(true);
        }
    });

    it(`refuses the tree, the box, the capabilities, the live surfaces, and anything unnamed`, () => {
        for (const path of [`/`, `/workspace`, `/workspace/src/app.ts`, `/preview`, `/capabilities`, `/browsers`, `/subagents`, `/terminal`, `/sandbox`, `/sandbox/secrets`, `/sandbox/accessories`, `/ext/projects`]) {
            expect(deskAllowedPath(path), path).toBe(false);
        }
    });
});
