import type { DeclaredCommand } from "../activity/outbound.js";
import { actionRefusal, outboundRefusal } from "./outbound-guard.js";

// What an enabled WhatsApp extension declares of its `whatsapp` tool (its manifest's `commandActions`).
const WHATSAPP: readonly DeclaredCommand[] = [
    { provider: "whatsapp", action: "message.send", command: ["whatsapp", "send"], channel: { arg: 0 }, content: { arg: 1, rest: true } },
    { provider: "whatsapp", action: "reaction.add", command: ["whatsapp", "react"], channel: { arg: 0 } },
];
const SEND = `whatsapp send 4915112345678 deploy is out`;

// The owner's action rules on one command, as every runtime's command guard asks them (command-guard.ts).
describe("outbound rules", () => {
    test("an undeclared command passes untouched", () => {
        expect(outboundRefusal({ "whatsapp.message.send": "deny" }, "ls -la", WHATSAPP)).toBeUndefined();
    });

    test("no rules at all ask nothing", () => {
        expect(outboundRefusal({}, SEND, WHATSAPP)).toBeUndefined();
    });

    test("an allowed declared command passes untouched", () => {
        expect(outboundRefusal({ "slack.message.send": "deny", "whatsapp.reaction.add": "deny" }, SEND, WHATSAPP)).toBeUndefined();
    });

    test("a denied command is refused before it runs, with the rule's sentence", () => {
        expect(outboundRefusal({ "whatsapp.message.send": "deny" }, SEND, WHATSAPP)).toBe("whatsapp message.send is refused by the action rules");
    });

    test("a held command is refused toward the approvals queue: the held form of a send", () => {
        expect(outboundRefusal({ "whatsapp.*": "hold" }, SEND, WHATSAPP)).toContain(".intentic/config/approvals/");
    });

    test("a command no enabled extension declares is not the rules' to judge", () => {
        expect(outboundRefusal({ "whatsapp.message.send": "deny" }, SEND, [])).toBeUndefined();
    });

    test("a command its declaration holds while unruled is refused with no rule written, and an allow rule lets it go", () => {
        const held: readonly DeclaredCommand[] = WHATSAPP.map((entry) => ({ ...entry, unruled: "hold" }));
        expect(outboundRefusal({}, SEND, held)).toContain(".intentic/config/approvals/");
        expect(outboundRefusal({ "whatsapp.message.send": "allow" }, SEND, held)).toBeUndefined();
        expect(outboundRefusal({}, SEND, WHATSAPP)).toBeUndefined();
    });

    test("a command the card's backend gates is left to the outward-action door, whatever the rule says", () => {
        const backend: readonly DeclaredCommand[] = WHATSAPP.map((entry) => ({ ...entry, gatedBy: "backend", unruled: "hold" }));
        for (const rule of ["hold", "deny"] as const) {
            expect(outboundRefusal({ "whatsapp.message.send": rule }, SEND, backend)).toBeUndefined();
        }
        // The deprecated `selfGated` reads the same.
        expect(outboundRefusal({ "whatsapp.*": "deny" }, SEND, WHATSAPP.map((entry) => ({ ...entry, selfGated: true })))).toBeUndefined();
    });

    test("the gateway's request and the command guard's command read the same verdict", () => {
        expect(actionRefusal({ "slack.message.send": "deny" }, { provider: "slack", type: "message.send" })).toBe("slack message.send is refused by the action rules");
        expect(actionRefusal({ "slack.message.send": "deny" }, { provider: "slack", type: "message.edit" })).toBeUndefined();
    });
});
