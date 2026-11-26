import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { type DeclaringCard, outwardActionsFrom } from "./outward-actions.js";

// What Guardrails and the public-office preset offer a rule for comes from the extensions' manifests: here, every
// extension in this repository enabled, the way a sandbox with all of them switched on reads them.

const extensions = join(repoRoot(import.meta.url), "_extensions");
const cards: DeclaringCard[] = readdirSync(extensions).flatMap((name) => {
    let text: string;
    try {
        text = readFileSync(join(extensions, name, "intentic-extension.json"), "utf8");
    } catch {
        // allow(silent-catch): a folder with no manifest (a package's leftover node_modules) is not an extension.
        return [];
    }
    const manifest = ExtensionManifestSchema.parse(JSON.parse(text));
    return (manifest.contributes?.capabilities ?? []).map((spec) => ({ spec, extension: { id: `${manifest.publisher}.${manifest.name}` } }));
});
const declared = outwardActionsFrom(cards);
const keys = declared.offered.map((action) => action.key);

test("offers every outward action the chat and mail extensions declare, under their card ids, each once", () => {
    // Every key the daemon's own table held before the extensions declared them (2026-11-25), e-urzad's aside: those are
    // declared in its own repository.
    expect(keys).toEqual(
        expect.arrayContaining([
            "discord.message.send",
            "discord.reaction.add",
            "slack.message.send",
            "slack.message.edit",
            "slack.reaction.add",
            "slack.reaction.remove",
            "telegram.message.send",
            "telegram.message.edit",
            "telegram.reaction.add",
            "whatsapp.message.send",
            "imap.message.send",
            "microsoft365.mail.send",
            "microsoft365.calendar.write",
            "microsoft365.files.upload",
        ]),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(declared.offered.find((action) => action.key === "slack.message.send")?.extension).toBe("intentic.slack");
});

test("offers no read, and nothing of the sandbox's own", () => {
    expect(keys.filter((key) => /\.(messages|file)\.read$/u.test(key) || key.startsWith("agents."))).toEqual([]);
});

test("recognises the WhatsApp tool's sends, and leaves the mail tools' to their backends' door, held while no rule names them", () => {
    expect(declared.commands.find((command) => command.command.join(" ") === "whatsapp send")).toMatchObject({ provider: "whatsapp", action: "message.send" });
    const mail = declared.commands.filter((command) => command.provider === "imap" || command.provider === "microsoft365");
    expect(mail.length).toBeGreaterThan(0);
    expect(mail.every((command) => command.gatedBy === "backend" && command.unruled === "hold" && command.selfGated === undefined)).toBe(true);
    const unruled = (key: string) => declared.offered.find((action) => action.key === key)?.unruled;
    expect(["imap.message.send", "microsoft365.mail.send", "microsoft365.calendar.write", "microsoft365.files.upload"].map(unruled)).toEqual(["hold", "hold", "hold", "hold"]);
    expect(unruled("whatsapp.message.send")).toBeUndefined();
    expect(unruled("slack.message.send")).toBeUndefined();
});

test("offers a key once, under the first extension that declares it", () => {
    const slack = cards.find((card) => card.spec.id === "slack");
    if (slack === undefined) {
        throw new Error("no slack card in this repository");
    }
    const twice = outwardActionsFrom([slack, { ...slack, extension: { id: "someone.else" } }]);
    expect(twice.offered.filter((action) => action.key === "slack.message.send")).toEqual([{ key: "slack.message.send", extension: "intentic.slack" }]);
});

test("offers what a declaration says an action comes to while unruled, and reads a deprecated selfGated as held", () => {
    const whatsapp = cards.find((card) => card.spec.id === "whatsapp");
    const spec = whatsapp?.spec;
    if (whatsapp === undefined || spec?.kind !== "cli") {
        throw new Error("no whatsapp card in this repository");
    }
    type Commands = NonNullable<typeof spec.commandActions>;
    const withCommands = (commandActions: Commands): DeclaringCard => ({ ...whatsapp, spec: { ...spec, commandActions } });
    const send = { action: "message.send", command: ["whatsapp", "send"] };
    const offered = (commandActions: Commands) =>
        outwardActionsFrom([withCommands(commandActions)]).offered.find((action) => action.key === "whatsapp.message.send")?.unruled;
    expect(offered([{ ...send, unruled: "hold" }])).toBe("hold");
    expect(offered([{ ...send, unruled: "allow" }])).toBeUndefined();
    expect(offered([{ ...send, selfGated: true }])).toBe("hold");
    expect(offered([{ ...send, selfGated: true, unruled: "allow" }])).toBeUndefined();
    expect(offered([send])).toBeUndefined();
});
