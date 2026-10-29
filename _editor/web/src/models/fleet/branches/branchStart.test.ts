import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { Conversation } from "../../conversations/session/conversation";
import { startChoosable, startFromFacts, startOnBranch, startOnCopy, startOnMainLine, startScopeOf, unlinkBranch } from "./branchStart";

// Pins how a draft is started from a branch or another agent's copy: one start at a time, a private copy here, and only
// before the first turn is taken.

const BRANCH = { repo: `apps/web`, branch: `feature/login` };
const ORIGIN = { id: `origin`, actsAs: undefined, startIn: undefined };

afterEach(() => resetSandboxScope());

describe(`a draft's start`, () => {
    it(`starts from the main line by default, and is the draft's to choose`, () => {
        const chat = new Conversation(`c1`);
        expect(startScopeOf(chat)).toEqual({});
        expect(startFromFacts(chat)).toEqual({ startOffered: true, startSet: false });
    });

    it(`takes a branch as a start of its own, dropping a fork or a fresh session it held`, () => {
        const chat = new Conversation(`c1`);
        chat.isolated.value = false;
        chat.pendingFreshOf.value = { conversationId: `origin`, kind: `review` };
        startOnBranch(chat, BRANCH);
        expect(chat.isolated.value).toBe(true);
        expect(chat.pendingFreshOf.value).toBeUndefined();
        expect(chat.pendingFromBranch.value).toEqual(BRANCH);
        expect(startScopeOf(chat)).toEqual(BRANCH);
        expect(startFromFacts(chat)).toEqual({ startOffered: true, startSet: true });
        unlinkBranch(chat);
        expect(chat.pendingFromBranch.value).toBeUndefined();
    });

    it(`takes another agent's copy as the reader's own ask, and goes back to the main line from either`, () => {
        const chat = new Conversation(`c1`);
        startOnBranch(chat, BRANCH);
        startOnCopy(chat, ORIGIN);
        expect(chat.pendingFromBranch.value).toBeUndefined();
        expect(chat.pendingFreshOf.value).toEqual({ conversationId: `origin`, kind: `ask` });
        expect(startScopeOf(chat)).toEqual({ agent: `origin` });
        startOnMainLine(chat);
        expect(chat.pendingFreshOf.value).toBeUndefined();
        expect(startScopeOf(chat)).toEqual({});
    });

    it(`leaves a check's fresh session to its own strip, and offers nothing once the chat ran or runs elsewhere`, () => {
        const check = new Conversation(`c1`);
        check.pendingFreshOf.value = { conversationId: `origin`, kind: `test` };
        expect(startFromFacts(check).startOffered).toBe(false);
        startOnMainLine(check);
        expect(check.pendingFreshOf.value).toEqual({ conversationId: `origin`, kind: `test` });

        const ran = new Conversation(`c2`);
        ran.registered.value = true;
        expect(startChoosable(ran)).toBe(false);
        const away = new Conversation(`c3`);
        away.box.value = `box-2`;
        expect(startChoosable(away)).toBe(false);
    });
});
