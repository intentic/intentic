import { outboundRefusal } from "./outbound-guard.js";

const DISCORD_SEND = `curl -s -X POST "https://discord.com/api/v10/channels/123/messages" -H "Authorization: Bot $TOKEN" -d '{"content":"hi"}'`;

// The owner's action rules on one command, as every runtime's command guard asks them (command-guard.ts).
describe("outbound rules", () => {
    test("an unclassified command passes untouched", () => {
        expect(outboundRefusal({ "discord.message.send": "deny" }, "ls -la")).toBeUndefined();
    });

    test("no rules at all ask nothing", () => {
        expect(outboundRefusal({}, DISCORD_SEND)).toBeUndefined();
    });

    test("an allowed classified call passes untouched", () => {
        expect(outboundRefusal({ "slack.message.send": "deny" }, DISCORD_SEND)).toBeUndefined();
    });

    test("a denied call is refused before it runs, with the rule's sentence", () => {
        expect(outboundRefusal({ "discord.message.send": "deny" }, DISCORD_SEND)).toContain("discord message.send");
    });

    test("a held call is refused toward the approvals queue: the held form of a send", () => {
        expect(outboundRefusal({ "discord.*": "hold" }, DISCORD_SEND)).toContain(".intentic/config/approvals/");
    });
});
