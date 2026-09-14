import { describe, expect, it } from "vitest";
import { accentOf, freeProjectName, monogramOf, previewPath, projectIds, slugOf, summaryOf } from "./projects.js";

describe(`which repositories are projects`, () => {
    it(`lists every repository but the workspace's own, in name order`, () => {
        expect(projectIds([`shop`, `root`, `blog`, `tools/cli`])).toEqual([`blog`, `shop`, `tools/cli`]);
        expect(projectIds([`root`])).toEqual([]);
    });
});

describe(`a tile's summary`, () => {
    it(`is the README's first paragraph that is not a heading or a badge`, () => {
        expect(summaryOf(`# Shop\n\n[![ci](x)](y)\n\nA one page site for the bakery,\nwith the menu.\n\nMore below.`)).toBe(
            `A one page site for the bakery, with the menu.`,
        );
    });

    it(`is empty for a README with nothing but a heading, which is what a new project starts with`, () => {
        expect(summaryOf(`# new-project\n`)).toBe(``);
    });

    it(`drops the HTML a hand-written README opens with, tags and all`, () => {
        expect(summaryOf(`# Shop\n\n<p align="center"><img src="logo.png"></p>\n\nA one page site<br>for the bakery.`)).toBe(
            `A one page site for the bakery.`,
        );
    });

    it(`treats a heading written as HTML as a heading, not as the first sentence`, () => {
        expect(summaryOf(`<h1>kube-coder</h1>\n\n**One Helm chart turns a cluster into a fleet of cloud dev workspaces.**`)).toBe(
            `One Helm chart turns a cluster into a fleet of cloud dev workspaces.`,
        );
    });

    it(`reads markdown as the words it renders to, not the syntax it is written in`, () => {
        expect(summaryOf(`# x\n\nA site for [the bakery](https://bakery.example), with **fresh** bread and \`pnpm dev\`.`)).toBe(
            `A site for the bakery, with fresh bread and pnpm dev.`,
        );
    });

    it(`keeps an angle-bracket placeholder, which is text a README wrote and not markup`, () => {
        expect(summaryOf(`# @intentic/ingress\n\nThe edge owns \`*.<zone>\` and the one wildcard certificate.`)).toBe(
            `The edge owns *.<zone> and the one wildcard certificate.`,
        );
    });

    it(`unwraps a bold span that has an italic one inside it`, () => {
        expect(summaryOf(`# x\n\n**Give each agent its own branch — of *both* its code and its memory.**`)).toBe(
            `Give each agent its own branch — of both its code and its memory.`,
        );
    });

    it(`does not mistake the dots in a hostname for the end of a sentence`, () => {
        const readme = `# proxy\n\nA strict HTTP proxy that only forwards POST requests to /v1/responses to the OpenAI API (https://api.openai.com) and refuses everything else.`;

        expect(summaryOf(readme)).toBe(`A strict HTTP proxy that only forwards POST requests to /v1/responses to the OpenAI API (https://api.openai.com) and…`);
    });

    it(`decodes the entities a README writes instead of the characters`, () => {
        expect(summaryOf(`# x\n\nBread &amp; butter &#8212; daily.`)).toBe(`Bread & butter — daily.`);
    });

    it(`skips a badge whose link target carries parentheses of its own`, () => {
        const badge = `[![Benchmark: 79.4%](https://img.shields.io/badge/aider--polyglot-79.4%25%20(claude)-brightgreen)](https://github.com/imran31415/kubecoder-bench)`;

        expect(summaryOf(`# kube-coder\n\n${badge}\n\n---\n\nRuns coding agents on Kubernetes.`)).toBe(`Runs coding agents on Kubernetes.`);
    });

    it(`skips fenced code, lists and tables, which no summary line can carry`, () => {
        expect(summaryOf(`# Tool\n\n\`\`\`bash\npnpm install\n\`\`\`\n\n- a bullet\n\n| a | b |\n\nThe real first paragraph.`)).toBe(
            `The real first paragraph.`,
        );
    });

    it(`cuts a long paragraph at a full stop rather than showing the whole essay`, () => {
        const readme = `# Bakery\n\nA one page site for the bakery, with the menu and the hours. It also lists the specials, the delivery area and every seasonal loaf the bakers have ever baked.`;
        expect(summaryOf(readme)).toBe(`A one page site for the bakery, with the menu and the hours.`);
    });

    it(`cuts a long paragraph with no full stop at a whole word`, () => {
        const long = `A workspace for coding agents `.repeat(6).trim();
        const summary = summaryOf(`# x\n\n${long}`);

        expect(summary.endsWith(`…`)).toBe(true);
        expect(summary.length).toBeLessThanOrEqual(121);
        expect(long.startsWith(`${summary.slice(0, -1)} `)).toBe(true);
    });
});

describe(`naming a new project`, () => {
    it(`offers the first free name in the series, so repeated presses do not collide`, () => {
        expect(freeProjectName([])).toBe(`new-project`);
        expect(freeProjectName([`new-project`])).toBe(`new-project-2`);
        expect(freeProjectName([`new-project`, `new-project-2`, `shop`])).toBe(`new-project-3`);
    });

    it(`turns what was typed into a folder name the daemon accepts`, () => {
        expect(slugOf(`  My Bakery Site! `)).toBe(`my-bakery-site`);
        expect(slugOf(`--weird..name--`)).toBe(`weird..name`);
        expect(slugOf(`###`)).toBe(``);
    });
});

describe(`the tile's monogram`, () => {
    it(`is the first two letters of the project's own name, not its parent folder's`, () => {
        expect(monogramOf(`web`)).toBe(`we`);
        expect(monogramOf(`tools/cli`)).toBe(`cl`);
        expect(monogramOf(`a`)).toBe(`a`);
    });

    it(`wears one of the five palette slots, the same one every time that project is drawn`, () => {
        expect(accentOf(`shop`)).toBe(accentOf(`shop`));
        for (const id of [`shop`, `blog`, `tools/cli`, ``, `a`]) {
            expect([`1`, `2`, `3`, `4`, `5`]).toContain(accentOf(id));
        }
    });

    it(`does not give every project the same slot`, () => {
        const slots = new Set([`shop`, `blog`, `web`, `tools/cli`, `docs`, `api`, `site`].map(accentOf));

        expect(slots.size).toBeGreaterThan(1);
    });
});

describe(`where See it goes`, () => {
    it(`opens the preview on the repository's own target`, () => {
        expect(previewPath(`shop`)).toBe(`/preview?target=repo%3Ashop`);
    });
});
