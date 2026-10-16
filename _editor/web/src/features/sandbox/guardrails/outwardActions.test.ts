// What Guardrails' outward-action rows are made of: one row per service whose extension is on or that still has a rule,
// one rule when its actions agree and none when they were set apart, and a write that names each action's own key,
// never a wildcard, which would also catch the service's reads.
import { ADMISSION_KEYS, actionRules, admissionOptions, serviceRows, withServiceRule } from "./outwardActions";

const none = new Set<string>();

it(`offers a service while its extension is on, and nothing for one that is off`, () => {
    expect(serviceRows({}, none)).toEqual([]);
    const rows = serviceRows({}, new Set([`intentic.slack`]));
    expect(rows.map((row) => row.service)).toEqual([`slack`]);
    expect(rows[0]?.keys).toEqual([`slack.message.send`, `slack.message.edit`, `slack.reaction.add`, `slack.reaction.remove`]);
    expect(rows[0]?.rule).toBe(`allow`);
});

it(`keeps offering a service whose rule outlived its extension, since the gate still reads it`, () => {
    expect(serviceRows({ "discord.message.send": `hold` }, none).map((row) => row.service)).toEqual([`discord`]);
});

it(`never makes starting subagents a service row: it has a posture of its own`, () => {
    expect(serviceRows({ "agents.spawn": `deny` }, none)).toEqual([]);
});

it(`files both e-urzad services under the one extension`, () => {
    expect(serviceRows({}, new Set([`intentic.e-urzad`])).map((row) => row.service)).toEqual([`ezdrp`, `edoreczenia`]);
});

it(`reads a service's wildcard as the rule of every action it covers`, () => {
    expect(serviceRows({ "telegram.*": `deny` }, none)[0]?.rule).toBe(`deny`);
});

it(`says no single rule when the actions were set apart, and how each stands`, () => {
    const rules = { "slack.message.send": `hold`, "slack.reaction.add": `deny` } as const;
    const [row] = serviceRows(rules, none);
    expect(row?.rule).toBeUndefined();
    expect(actionRules(rules, row!)).toEqual([
        { key: `slack.message.send`, rule: `hold` },
        { key: `slack.message.edit`, rule: `allow` },
        { key: `slack.reaction.add`, rule: `deny` },
        { key: `slack.reaction.remove`, rule: `allow` },
    ]);
});

it(`writes every action of the service to its own key, and leaves every other rule alone`, () => {
    const [row] = serviceRows({}, new Set([`intentic.whatsapp`]));
    const next = withServiceRule({ "agents.spawn": `hold`, "slack.message.send": `deny` }, row!, `hold`);
    expect(next).toEqual({ "agents.spawn": `hold`, "slack.message.send": `deny`, "whatsapp.message.send": `hold` });
    expect(Object.keys(next).some((key) => key.endsWith(`.*`))).toBe(false);
});

it(`lists the triggers a stranger can reach first, and offers a CI workflow no hold`, () => {
    expect(ADMISSION_KEYS.slice(0, 2)).toEqual([`webchat`, `issues`]);
    expect(admissionOptions(`workflow`).map((option) => option.value)).toEqual([`allow`, `deny`]);
    expect(admissionOptions(`webchat`).map((option) => option.value)).toEqual([`allow`, `hold`, `deny`]);
});
