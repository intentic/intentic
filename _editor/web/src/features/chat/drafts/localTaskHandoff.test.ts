import "@intentic/testing/dom";
import { parseTaskHandoff, receiveTaskHandoff, rememberTaskSent, taskAlreadySent } from "./localTaskHandoff";

const encoded = (): string => {
    const json = JSON.stringify({ v: 1, id: `task-1`, text: `Ship the feature` });
    return Buffer.from(json, `utf8`).toString(`base64url`);
};

describe(`localTaskHandoff`, () => {
    it(`parses a valid task query`, () => {
        expect(parseTaskHandoff(encoded())).toEqual({ v: 1, id: `task-1`, text: `Ship the feature` });
    });

    it(`strips the task query and keeps the handoff for arrival`, () => {
        const raw = encoded();
        const next = receiveTaskHandoff({ path: `/`, query: { task: raw, sandbox: `sb1` }, hash: `` }, false, () => `/`);
        expect(next).toEqual({ path: `/`, query: { sandbox: `sb1` }, hash: ``, replace: true });
    });

    it(`remembers sent ids in localStorage`, () => {
        localStorage.clear();
        rememberTaskSent(`task-9`);
        expect(taskAlreadySent(`task-9`)).toBe(true);
        expect(taskAlreadySent(`other`)).toBe(false);
    });
});
