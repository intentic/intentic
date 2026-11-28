import type { Services } from "../../composition.js";
import { onLinkTaskStatusNudge } from "../link-task-status-wait.js";
import { type LinkServices, linkTaskDepsOf, noteLinkTurnSettled, noteLinkTurnStarted, startUnstartedTasks } from "../link-tasks.js";
import { personTaskDepsOf } from "../person-tasks.js";
import { registerAskingKinds } from "../../s2s/tasks/asking.js";
import { createTaskPusher } from "./task-push.js";
import { contactStatusOf, contactTaskBook, registerTakingKinds, type TakingDeps } from "./taking.js";

/* TASKS BETWEEN CONTACTS, wired to this daemon (2026-11-27, docs/architecture/messages.md "Tasks"): the taking side's
 * kinds (taking.ts) over the contacts' task book and the person tasks', the status each pushes back (task-push.ts), the
 * asking side's `task.update` and late refusals (asking.ts), the turns' own endings moving a contact's task as they move
 * a link's (a person-scoped contact's ride the person tasks' notes, links/person-tasks.ts), and at boot every task filed
 * but never started started, and every status pushed again. Registered before the outbox starts draining, so no answer
 * from before a restart goes unheard. */

export type ContactTaskServices = LinkServices &
    Pick<Services, "s2s" | "contactTasks" | "contactSends" | "personTasks" | "linkedChildren" | "events" | "ownerEmail" | "members" | "agents">;

/** The taking side's link and person task code off the daemon's services, the link code's book the contacts'. */
export const takingCodeOf = (services: ContactTaskServices): Pick<TakingDeps, "link" | "person"> => ({
    link: { ...linkTaskDepsOf(services), links: contactTaskBook(services.contactTasks, services.s2s.contacts) },
    person: personTaskDepsOf(services),
});

/** Starts both sides of contacts' tasks; answers the stop. */
export const startContactTasks = (services: ContactTaskServices): (() => void) => {
    const { logger } = services;
    const code = takingCodeOf(services);
    const pusher = createTaskPusher({
        contacts: services.s2s.contacts,
        book: services.contactTasks,
        personTasks: services.personTasks,
        status: (row, task) => contactStatusOf(code, row, task),
        outbox: services.s2s.outbox,
        now: Date.now,
        logger,
    });
    const deps: TakingDeps = { ...code, hear: services.s2s.hear, push: pusher.push };
    const book = { links: code.link.links, logger };
    const stops = [
        registerTakingKinds(services.s2s.kinds, deps),
        registerAskingKinds(services.s2s.kinds, services.s2s.outbox, services.contactSends, services.linkedChildren),
        onLinkTaskStatusNudge(pusher.nudge),
        // A run parking on a card is nudged by links' own subscription (noteLinkTurnAwaiting reads no book).
        services.events.subscribe("run.settled", (settled) => noteLinkTurnSettled(book, settled)),
        services.events.subscribe("run.started", (started) => noteLinkTurnStarted(book, started)),
        pusher.start(),
    ];
    void startUnstartedTasks(code.link).catch((error: Error) => logger.warn({ err: error }, "contact: tasks filed before a restart not started"));
    void pusher.sweep(true).catch((error: Error) => logger.warn({ err: error }, "contact: task statuses not pushed after a restart"));
    return () => {
        for (const stop of stops) {
            stop();
        }
    };
};
