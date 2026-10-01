import { twinsOf } from "../titleTwins";

// Three chats opened by one prompt sent again on other providers read alike in every list; these are the titles that
// then need a fact beside them.

test(`a title two chats share is a twin, and one only one chat has is not`, () => {
    expect([...twinsOf([`Map the decks`, `Fix the build`, `Map the decks`, `Map the decks`])]).toEqual([`Map the decks`]);
});

test(`untitled chats are never twins of each other`, () => {
    expect(twinsOf([null, null, undefined, `Fix the build`]).size).toBe(0);
});
