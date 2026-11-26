// What Guardrails' outward-action rows are made of: one row per service an enabled extension declares actions for (an
// older daemon's fixed list for the extensions on) or that still has a rule,
// one rule when its actions agree and none when they were set apart, and a write that names each action's own key,
// never a wildcard, which would also catch the service's reads.
import type { OutwardAction } from "@intentic/sandbox-contract/schemas/data-protection";
import { ADMISSION_KEYS, actionRules, admissionOptions, legacyOutwardActions, serviceRows, withServiceRule } from "./outwardActions";

const none: readonly OutwardAction[] = [];
// What a daemon serves for an enabled Slack extension: its declared actions that are more than reads.
const slack: readonly OutwardAction[] = [`slack.message.send`, `slack.message.edit`, `slack.reaction.add`, `slack.reaction.remove`].map((key) => ({
    key,
    extension: `intentic.slack`,
}));

it(`offers a service its enabled extension declares actions for, and nothing for one nobody declares`, () => {
    expect(serviceRows({}, none)).toEqual([]);
    const rows = serviceRows({}, slack);
    expect(rows.map((row) => row.service)).toEqual([`slack`]);
    expect(rows[0]?.keys).toEqual([`slack.message.send`, `slack.message.edit`, `slack.reaction.add`, `slack.reaction.remove`]);
    expect(rows[0]?.rule).toBe(`allow`);
});

it(`keeps offering a service whose rule outlived its extension, over the keys the rules name, since the gate still reads them`, () => {
    expect(serviceRows({ "discord.message.send": `hold` }, none)).toEqual([{ service: `discord`, keys: [`discord.message.send`], rule: `hold` }]);
    // A rule on a key its extension no longer declares rides that extension's row only when the extension is gone.
    expect(serviceRows({ "slack.messages.read": `deny` }, slack)[0]?.keys).not.toContain(`slack.messages.read`);
});

it(`never makes starting subagents a service row: it has a posture of its own`, () => {
    expect(serviceRows({ "agents.spawn": `deny`, "agents.spawn.codex": `hold` }, none)).toEqual([]);
});

it(`offers an older daemon's fixed list for the extensions switched on, e-urzad's two services under the one extension`, () => {
    const older = legacyOutwardActions(new Set([`intentic.e-urzad`, `intentic.whatsapp`]));
    expect(serviceRows({}, older).map((row) => row.service)).toEqual([`whatsapp`, `ezdrp`, `edoreczenia`]);
    expect(legacyOutwardActions(new Set())).toEqual([]);
});

it(`reads a service's wildcard as the rule of every action it covers`, () => {
    expect(serviceRows({ "telegram.*": `deny` }, [{ key: `telegram.message.send`, extension: `intentic.telegram` }])[0]?.rule).toBe(`deny`);
    // With no extension declaring the service, the wildcard is the row's one key.
    expect(serviceRows({ "telegram.*": `deny` }, none)).toEqual([{ service: `telegram`, keys: [`telegram.*`], rule: `deny` }]);
});

it(`says no single rule when the actions were set apart, and how each stands`, () => {
    const rules = { "slack.message.send": `hold`, "slack.reaction.add": `deny` } as const;
    const [row] = serviceRows(rules, slack);
    expect(row?.rule).toBeUndefined();
    expect(actionRules(rules, row!)).toEqual([
        { key: `slack.message.send`, rule: `hold` },
        { key: `slack.message.edit`, rule: `allow` },
        { key: `slack.reaction.add`, rule: `deny` },
        { key: `slack.reaction.remove`, rule: `allow` },
    ]);
});

it(`reads an action whose tool holds it until a rule says otherwise as held while no rule names it`, () => {
    const mail: readonly OutwardAction[] = [
        { key: `microsoft365.mail.send`, extension: `intentic.microsoft-365`, unruled: `hold` },
        { key: `microsoft365.files.upload`, extension: `intentic.microsoft-365`, unruled: `hold` },
    ];
    expect(serviceRows({}, mail)[0]?.rule).toBe(`hold`);
    expect(serviceRows({ "microsoft365.*": `allow` }, mail)[0]?.rule).toBe(`allow`);
    const rules = { "microsoft365.files.upload": `allow` } as const;
    const [row] = serviceRows(rules, mail);
    expect(row?.rule).toBeUndefined();
    expect(actionRules(rules, row!, mail)).toEqual([
        { key: `microsoft365.mail.send`, rule: `hold` },
        { key: `microsoft365.files.upload`, rule: `allow` },
    ]);
});

it(`writes every action of the service to its own key, and leaves every other rule alone`, () => {
    const [row] = serviceRows({}, [{ key: `whatsapp.message.send`, extension: `intentic.whatsapp` }]);
    const next = withServiceRule({ "agents.spawn": `hold`, "slack.message.send": `deny` }, row!, `hold`);
    expect(next).toEqual({ "agents.spawn": `hold`, "slack.message.send": `deny`, "whatsapp.message.send": `hold` });
    expect(Object.keys(next).some((key) => key.endsWith(`.*`))).toBe(false);
});

it(`lists the triggers a stranger can reach first, and offers a CI workflow no hold`, () => {
    expect(ADMISSION_KEYS.slice(0, 2)).toEqual([`webchat`, `issues`]);
    expect(admissionOptions(`workflow`).map((option) => option.value)).toEqual([`allow`, `deny`]);
    expect(admissionOptions(`webchat`).map((option) => option.value)).toEqual([`allow`, `hold`, `deny`]);
});
