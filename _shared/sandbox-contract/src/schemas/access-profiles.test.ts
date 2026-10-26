import { AccessProfileSchema, profileAccess } from "./access-profiles.js";
import { accessRefusal, tierOf } from "./members.js";

// A profile reads like a roster row that never manages: `run` when it does not say, no hand edits for a chat or a home,
// and the tier its holders get is what those answers add up to.

describe(`profileAccess`, () => {
    it(`runs agents when it does not say, and edits nowhere`, () => {
        expect(profileAccess({})).toEqual({ manage: false, agents: `run`, see: undefined, edit: `none` });
        expect(tierOf(profileAccess({}))).toBe(`collaborator`);
    });

    it(`makes the tier its answers add up to`, () => {
        expect(tierOf(profileAccess({ agents: `chat`, areas: [`support`] }))).toBe(`guest`);
        expect(tierOf(profileAccess({ agents: `off` }))).toBe(`viewer`);
        expect(tierOf(profileAccess({ agents: `run`, areas: [`web`], edit: [`web`] }))).toBe(`writer`);
    });

    it(`never lets a chat or a home edit by hand, and keeps lands for a home alone`, () => {
        expect(profileAccess({ agents: `chat`, areas: [`support`], edit: `all` }).edit).toBe(`none`);
        expect(profileAccess({ agents: `home`, lands: true })).toEqual({ manage: false, agents: `home`, see: undefined, edit: `none`, lands: true });
        expect(profileAccess({ agents: `run`, lands: true })).toEqual({ manage: false, agents: `run`, see: undefined, edit: `none` });
    });

    it(`refuses what a grant would refuse`, () => {
        expect(accessRefusal(profileAccess({ agents: `chat` }))).toBe(
            `chatting with assistants needs at least one area: the assistants that work there are the ones they talk to`,
        );
        expect(accessRefusal(profileAccess({ areas: [`web`], edit: [`ops`] }))).toBe(`they can only edit where they can see: ops is not among their areas`);
    });
});

describe(`AccessProfileSchema`, () => {
    it(`takes a profile naming only an id, which limits nothing`, () => {
        expect(AccessProfileSchema.parse({ id: `everyone` })).toEqual({ id: `everyone` });
    });

    it(`keeps every answer it is given`, () => {
        const profile = {
            id: `marketing`,
            label: `Marketing`,
            areas: [`site`],
            credentials: { capabilities: [`reddit-work`], secrets: [] },
            aiAccounts: [`claude:work`],
            tools: { shell: false },
            assistants: [`copywriter`],
        };
        expect(AccessProfileSchema.parse(profile)).toEqual(profile);
    });
});
