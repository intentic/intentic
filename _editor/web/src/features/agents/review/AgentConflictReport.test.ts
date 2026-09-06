// @vitest-environment jsdom
//
// jsdom because the subject is the LADDER: which rungs a refusal offers, and what the sentence beside them
// claims. Both are template decisions over five states, and the component's own header names mounting it on
// its own as the point of it being a component at all.
import type { LandConflict } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

const { default: AgentConflictReport } = await import("./AgentConflictReport.vue");

let app: App | undefined;
let host: HTMLElement | undefined;

// The report's own props, with the four the tests never vary defaulted below. Spelled out rather than taken as
// a loose record, so a prop renamed on the component is a failure here rather than a silently ignored key.
interface ReportProps {
    readonly conflicts: readonly LandConflict[];
    readonly streaming?: boolean;
    readonly writing?: boolean;
    readonly busy?: boolean;
    readonly asked?: boolean;
    readonly box?: string;
}

const mount = async (props: ReportProps): Promise<HTMLElement> => {
    host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(AgentConflictReport, {
                streaming: false,
                writing: false,
                busy: false,
                asked: false,
                ...props,
            }),
    });
    // `Icon` is registered app-wide by the real app; here it is a stand-in, since no assertion is about a glyph.
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return host;
};

afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
    vi.restoreAllMocks();
});

const text = (el: HTMLElement): string => (el.textContent ?? ``).replace(/\s+/g, ` `).trim();
const hasButton = (el: HTMLElement, label: string): boolean => [...el.querySelectorAll(`button`)].some((b) => (b.textContent ?? ``).includes(label));

// A refusal the AGENT can clear on its own: the main line moved under its branch, and nothing here is held by
// the user's own edits. This is the only shape a three-way apply is offered for.
const agentsToFix: LandConflict[] = [{ repo: `api`, clean: 1, mainBranch: `main`, paths: [{ path: `src/server.ts`, reason: `diverged` }] }];

// The same refusal with the user's own uncommitted work in it, which is the shape the fixture in the demo
// carries and the one a real conflict usually has: git refuses a three-way apply through unstaged paths.
const mixed: LandConflict[] = [
    {
        repo: `api`,
        clean: 1,
        mainBranch: `main`,
        paths: [
            { path: `src/server.ts`, reason: `diverged` },
            { path: `src/db/schema.ts`, reason: `workspace` },
        ],
    },
];

it(`offers the agent, the user and the merge when the conflict is the agent's alone and this is its own box`, async () => {
    const el = await mount({ conflicts: agentsToFix });
    expect(hasButton(el, `Have the agent resolve it`)).toBe(true);
    expect(hasButton(el, `Land with conflict markers`)).toBe(true);
    expect(hasButton(el, `Open in`)).toBe(false);
});

/* THE TWO RUNGS THAT CANNOT REACH ANOTHER SANDBOX collapse into the crossing, and nothing else moves. Asking
 * the agent needs the conversation the chat singleton holds for one daemon; committing your own edits needs
 * that box's workspace. Landing is neither, so it stays exactly where it was. */
it(`replaces both of those rungs with one crossing when the agent is in another box`, async () => {
    const el = await mount({ conflicts: agentsToFix, box: `acme-laptop` });
    expect(hasButton(el, `Have the agent resolve it`)).toBe(false);
    expect(hasButton(el, `Commit or stash yours`)).toBe(false);
    expect(hasButton(el, `Open in acme-laptop`)).toBe(true);
    // The land is addressed by agent id and writes into the workspace the conflict is actually about, so it
    // crosses intact. Dropping it would leave a distant conflict with no action on it at all.
    expect(hasButton(el, `Land with conflict markers`)).toBe(true);
});

/* THE CLAIM THE CROSSING MAKES HAS TO MATCH THE ROWS UNDER IT.
 *
 * The sentence beside the crossing ended "Landing with conflict markers still works from here", unconditionally,
 * and that is false in the commonest shape a conflict comes in: a `workspace` blocker means git would refuse the
 * three-way apply, so `mergeable` is false and the row is not drawn. The block was promising an action it did
 * not offer, one line above the empty space where it would have been. */
it(`only promises the merge when the merge is actually on offer`, async () => {
    const withMerge = await mount({ conflicts: agentsToFix, box: `acme-laptop` });
    expect(hasButton(withMerge, `Land with conflict markers`)).toBe(true);
    const withMergeText = text(withMerge);
    expect(withMergeText).toContain(`Land with conflict markers`);

    app?.unmount();
    host?.remove();

    const withoutMerge = await mount({ conflicts: mixed, box: `acme-laptop` });
    expect(hasButton(withoutMerge, `Land with conflict markers`)).toBe(false);
    const withoutMergeText = text(withoutMerge);
    expect(withoutMergeText).not.toContain(`Land with conflict markers still works`);
    expect(withoutMergeText).toContain(`acme-laptop`);
    expect(withoutMergeText).toContain(`edits`);
});

// The local path is unchanged by any of the above, which is the other half of the same guarantee: a conflict in
// the box you are standing in still ends on the user's own move.
it(`keeps the user's own rung on a local conflict held by their uncommitted edits`, async () => {
    const el = await mount({ conflicts: mixed });
    expect(hasButton(el, `Commit or stash yours`)).toBe(true);
    expect(hasButton(el, `Have the agent resolve it`)).toBe(true);
    expect(hasButton(el, `Land with conflict markers`)).toBe(false);
    expect(hasButton(el, `Open in`)).toBe(false);
});
