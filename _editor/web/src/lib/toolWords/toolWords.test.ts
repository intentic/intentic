import { plainToolWords } from "./toolWords";

// The words a maker sees for a call: the act, never the tool or the shell line.

describe(`plainToolWords`, () => {
    it(`calls a shell line that only looks through the project by what it did, past the cd`, () => {
        const target = `cd /work/intentic/_editor/ui/src && cat components/feedback/countBadge.ts; rg -n "small|size=" -n components`;
        expect(plainToolWords({ name: `Bash`, target })).toBe(`Looking through the project`);
    });

    it(`calls test and build runs "checks" and installs "installing"`, () => {
        expect(plainToolWords({ name: `Bash`, target: `cd /work && pnpm test src` })).toBe(`Running checks`);
        expect(plainToolWords({ name: `Bash`, target: `bunx vitest run foo` })).toBe(`Running checks`);
        expect(plainToolWords({ name: `Bash`, target: `pnpm add left-pad` })).toBe(`Installing something`);
    });

    it(`does not guess at a line it cannot place, and never prints it`, () => {
        const words = plainToolWords({ name: `Bash`, target: `./deploy.sh --prod && curl https://x.test` });
        expect(words).toBe(`Running a task`);
        expect(plainToolWords({ name: `bash` })).toBe(`Running a task`);
    });

    it(`names a file by its own name only, and only when asked`, () => {
        expect(plainToolWords({ name: `Read`, target: `/work/app/src/main.ts` })).toBe(`Reading main.ts`);
        expect(plainToolWords({ name: `Edit`, target: `/work/app/src/main.ts` })).toBe(`Editing main.ts`);
        expect(plainToolWords({ name: `Read`, target: `/work/app/src/main.ts` }, { file: false })).toBe(`Reading a file`);
        expect(plainToolWords({ name: `Edit`, target: `some words` })).toBe(`Editing a file`);
    });

    it(`covers the other tool families, and falls back on the category`, () => {
        expect(plainToolWords({ name: `Grep` })).toBe(`Searching the project`);
        expect(plainToolWords({ name: `WebSearch` })).toBe(`Searching the web`);
        expect(plainToolWords({ name: `WebFetch` })).toBe(`Reading a web page`);
        expect(plainToolWords({ name: `Browser click` })).toBe(`Using the browser`);
        expect(plainToolWords({ name: `Agent` })).toBe(`Working with a helper`);
        expect(plainToolWords({ name: `mcp__subagents__spawn` })).toBe(`Working with a helper`);
        expect(plainToolWords({ name: `mcp__posthog__query` })).toBe(`Using a connected tool`);
        expect(plainToolWords({ name: `Mystery`, category: `read` })).toBe(`Reading a file`);
        expect(plainToolWords({ name: `Mystery` })).toBe(`Working on it`);
    });
});
