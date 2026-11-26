import { registerDesktopCatalog } from "../i18n";
import { cardView, type QuitCardFacts } from "./quitCard";

// The quit card in the reader's words: one card for every question a close or a quit asks, each thing under way named
// with what quitting does to it, and the answers as whole outcomes.

await registerDesktopCatalog();

const QUIET: QuitCardFacts = { fromClose: false, unsaved: 0, agents: 0, work: [], moving: false, sandboxes: `keep` };
const view = (card: Partial<QuitCardFacts>, onWindows = false) => cardView({ ...QUIET, ...card }, onWindows);
const titles = (card: Partial<QuitCardFacts>, onWindows = false) => view(card, onWindows).choices.map((choice) => choice.title);

it(`asks the × once, with what a quit does to the sandboxes in the Quit answer itself`, () => {
    const close = view({ fromClose: true }, true);
    expect(close.title).toBe(`Close Intentic?`);
    expect(close.lead).toBeUndefined();
    expect(close.facts).toEqual([]);
    expect(close.choices.map(({ answer, title, hint }) => ({ answer, title, hint }))).toEqual([
        { answer: `tray`, title: `Keep Intentic in the tray`, hint: `It keeps running in the background and opens again instantly.` },
        { answer: `now`, title: `Quit Intentic`, hint: `Closes it completely. Your sandboxes keep running.` },
    ]);
    expect(close.choices[0]?.note).toBe(`Find its icon by the clock, or behind the ^ arrow.`);
    expect(close.canRemember).toBe(true);
    expect(view({ fromClose: true, sandboxes: `stop` }).choices[1]?.hint).toBe(
        `Closes it completely. Your sandboxes on this computer stop until you open it again.`,
    );
    expect(view({ fromClose: true, sandboxes: `idle` }).choices[1]?.hint).toBe(`Closes it completely.`);
    expect(view({ fromClose: true }).choices[0]?.note).toBeUndefined();
});

it(`folds the sandboxes question into the × card, so choosing Quit asks nothing more`, () => {
    const close = view({ fromClose: true, sandboxes: `ask` });
    expect(close.lead).toBe(`Your sandboxes are running on this computer.`);
    expect(close.choices.map(({ answer, keepSandboxes, title }) => ({ answer, keepSandboxes, title }))).toEqual([
        { answer: `tray`, keepSandboxes: undefined, title: `Keep Intentic in the tray` },
        { answer: `now`, keepSandboxes: true, title: `Quit, keep sandboxes running` },
        { answer: `now`, keepSandboxes: false, title: `Quit and stop sandboxes` },
    ]);
    expect(close.asksSandboxes).toBe(true);
});

it(`asks a quit about the sandboxes once, as a choice that becomes the setting`, () => {
    const quit = view({ sandboxes: `ask` });
    expect(quit.title).toBe(`Quit Intentic?`);
    expect(quit.lead).toBe(`Your sandboxes are running on this computer. Should they keep running after you quit?`);
    expect(quit.choices.map(({ title, hint }) => ({ title, hint }))).toEqual([
        { title: `Keep them running`, hint: `Reach them anytime from the browser or your phone.` },
        { title: `Stop them`, hint: `Frees up memory on this computer. They start again when you open Intentic.` },
    ]);
    expect(quit.asksSandboxes).toBe(true);
    expect(quit.canRemember).toBe(false);
});

it(`names work under way in plain words, costliest first, with what quitting does to each`, () => {
    const quit = view({
        unsaved: 2,
        agents: 1,
        work: [{ kind: `update`, sandbox: `work` }, { kind: `setup` }, { kind: `other` }],
    });
    expect(quit.lead).toBe(`Intentic is still busy.`);
    expect(quit.facts.map(({ tone, title, outcome }) => ({ tone, title, outcome }))).toEqual([
        { tone: `danger`, title: `2 windows have unsaved changes`, outcome: `Lost if you quit now.` },
        { tone: `warning`, title: `An agent is working`, outcome: `It stops if you quit now. You can continue it later.` },
        { tone: `warning`, title: `Setting up a sandbox`, outcome: `Stops if you quit now. Next time, it reuses what's already downloaded.` },
        { tone: `neutral`, title: `Updating “work”`, outcome: `Keeps going after you quit.` },
        { tone: `neutral`, title: `Finishing a background task`, outcome: `Keeps going after you quit.` },
    ]);
    // Never the old "Intentic is still a task on this computer on this computer".
    expect(quit.facts.every((fact) => !fact.title.includes(`on this computer on this computer`))).toBe(true);
    expect(titles({ unsaved: 2, agents: 1 })).toEqual([`Quit when it's done`, `Quit now`]);
    // A quit that loses unsaved changes says so in red, and is never answered for good.
    expect(quit.choices[1]?.danger).toBe(true);
    expect(quit.canRemember).toBe(false);
    expect(view({ agents: 3 }).facts[0]?.title).toBe(`3 agents are working`);
    expect(view({ work: [{ kind: `remove` }] }).facts[0]?.title).toBe(`Removing a sandbox`);
});

it(`lets "always do this" retire the question about work under way, but not over a move it would stop`, () => {
    expect(view({ work: [{ kind: `sync` }] }).canRemember).toBe(true);
    const moving = view({ moving: true, work: [{ kind: `setup` }] });
    expect(moving.canRemember).toBe(false);
    // A setup moving sandboxes is said once, as the move.
    expect(moving.facts.map((fact) => fact.title)).toEqual([`Moving your sandboxes`]);
    expect(moving.facts[0]?.outcome).toBe(
        `Stops if you quit now. Your sandboxes go back where they were the next time you set up this computer.`,
    );
});

it(`offers going back first when a quit would only lose unsaved changes`, () => {
    expect(titles({ unsaved: 1 })).toEqual([`Go back`, `Quit without saving`]);
    expect(view({ unsaved: 1 }).facts[0]?.title).toBe(`1 window has unsaved changes`);
    // From the ×, the tray is the way back.
    expect(titles({ fromClose: true, unsaved: 1 })).toEqual([`Keep Intentic in the tray`, `Quit without saving`]);
});

it(`offers the tray beside waiting when the × is pressed with work under way`, () => {
    const close = view({ fromClose: true, work: [{ kind: `power`, sandbox: `web` }] });
    expect(close.choices.map((choice) => choice.answer)).toEqual([`tray`, `wait`, `now`]);
    expect(close.choices[0]?.hint).toBe(`Everything keeps going in the background.`);
    expect(close.facts[0]?.title).toBe(`Starting or stopping “web”`);
});
