import { isBareConversationTitle } from "./conversation-title.js";

test.each(["Intentic", "boot.test.ts", "src/tests/boot.test.ts", "`boot.test.ts`", "src/start.ts src/boot.test.ts", "· fix", ""])("%s does not describe the work", (title) => {
    expect(isBareConversationTitle(title)).toBe(true);
});

test.each(["Fix authentication", "Fix #123", "Fix flaky boot timing test", "Audit Intentic for critical vulnerabilities", "boot.test.ts timing assumptions", "Test audit reviewer, batch 24"])("%s gives context beyond a reference", (title) => {
    expect(isBareConversationTitle(title)).toBe(false);
});
