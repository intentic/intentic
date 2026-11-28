import type { S2sContactTask, S2sContactTasks } from "@intentic/sandbox-contract/schemas/s2s";
import { refuse } from "@intentic/contract-serve";
import { LAPTOP_SANDBOX } from "../../world/sandboxRegistry";
import { contactOf } from "./s2sContacts";

// The tasks contacts handed each sandbox of the demo's world, as the daemon's contact task book keeps them
// (docs/architecture/messages.md, "Tasks"): the research desk, whose `task` grant says to ask first, has one task waiting
// for the owner's Allow and one running. Allow starts the waiting one and Decline ends it, written here so the list reads
// what the last press left; GET /s2s/tasks lists waiting ones first, then the newest.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const shopTasks = (): S2sContactTask[] => [
    {
        contact: `research`,
        contactName: `research-desk`,
        requestId: `rq-churn-cohorts`,
        conversationId: `link-churn-cohorts`,
        title: `Churn by signup cohort, October`,
        task: `Pull October's cancellations from the orders export and split them by the month each customer signed up.\nA table per cohort is enough; flag any cohort above 8%.`,
        state: `held`,
        askedAt: Date.now() - 25 * MINUTE,
        updatedAt: Date.now() - 25 * MINUTE,
    },
    {
        contact: `research`,
        contactName: `research-desk`,
        requestId: `rq-carrier-delays`,
        conversationId: `link-carrier-delays`,
        title: `Carrier delay summary for the weekly digest`,
        state: `running`,
        askedAt: Date.now() - 2 * HOUR,
        updatedAt: Date.now() - 4 * MINUTE,
    },
];

// The tasks each sandbox holds, by its daemon's address; anything but the laptop is this sandbox.
const books = new Map<string, S2sContactTask[]>();
const bookAt = (at: URL): string => (at.origin === LAPTOP_SANDBOX.origin ? `laptop` : `shop`);
const tasksAt = (at: URL): S2sContactTask[] => {
    const key = bookAt(at);
    const held = books.get(key) ?? (key === `shop` ? shopTasks() : []);
    books.set(key, held);
    return held;
};

const waitingFirst = (a: S2sContactTask, b: S2sContactTask): number => Number(b.state === `held`) - Number(a.state === `held`) || b.askedAt - a.askedAt;

export const contactTasks = (at: URL): S2sContactTasks => ({ tasks: tasksAt(at).toSorted(waitingFirst).map((task) => ({ ...task })) });

// As the daemon answers: only a task that still waits is decided, and the answer is the task as it stands now.
export const decideTask = (at: URL, contact: string, request: string, approve: boolean): S2sContactTask => {
    contactOf(at, contact);
    const task = tasksAt(at).find((each) => each.contact === contact && each.requestId === request) ?? refuse(`No task ${request} from ${contact} is here.`, 404);
    if (task.state !== `held`) {
        refuse(`That task is not waiting for an answer any more.`, 409);
    }
    const decided: S2sContactTask = { ...task, state: approve ? `running` : `declined`, updatedAt: Date.now() };
    books.set(
        bookAt(at),
        tasksAt(at).map((each) => (each === task ? decided : each)),
    );
    return { ...decided };
};
