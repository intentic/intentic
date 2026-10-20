import type { Projection, WindowProjection } from "./budget.js";
import type { BudgetClaim, BudgetForecast } from "./budget-planner.js";

/* WHAT A PARENT READS OF THE FAN-OUT PLANNER: where its child went, why one waits, and what the provider still carries.
   Said as the outcome, never as figures for the parent to do arithmetic on: the listing printed "84% left" and a
   sentence that a fan-out of N spends N times as fast, and ten children went onto that one account anyway (2026-10-20).
   Every figure is the planner's estimate and is said as one ("about"). */

// "about 40 min", "about 2h 10m": as coarse as an estimate deserves.
const hoursWords = (hours: number): string => {
    const minutes = Math.max(1, Math.round(hours * 60));
    if (minutes < 90) {
        return `about ${String(minutes)} min`;
    }
    const whole = Math.floor(minutes / 60);
    const rest = Math.round((minutes - whole * 60) / 10) * 10;
    return rest === 0 || whole >= 10 ? `about ${String(whole)}h` : `about ${String(whole)}h ${String(rest)}m`;
};

const agentsWords = (count: number): string => (count === 1 ? `1 agent` : `${String(count)} agents`);

const whose = (projection: Projection): string => projection.account.label ?? projection.account.id;

// "five-hour 26% left, reopens in about 1h 10m": a window as the words name it.
const windowWords = (window: WindowProjection): string => {
    const pool = window.window.pool ?? window.window.kind;
    const reopens = window.window.resetsInHours === undefined ? `` : `, reopens in ${hoursWords(window.window.resetsInHours)}`;
    return `${pool} ${String(Math.round(window.window.leftPoints))}% left${reopens}`;
};

// One account's standing with one more child on it: its binding window, its load, and how long it lasts at that.
const standingWords = (projection: Projection): string => {
    const binding = projection.binding;
    const load = `${agentsWords(projection.account.agents)} on it now`;
    if (binding === undefined) {
        return `${whose(projection)} (${load})`;
    }
    const lasts = binding.lastsHours === undefined ? `` : `, lasting ${hoursWords(binding.lastsHours)} with one more`;
    return `${whose(projection)} ${windowWords(binding)} (${load}${lasts})`;
};

/** Why a child waits on the budget, and what starts it: for its spawn result and its pending row. */
export const budgetHeldWords = (claim: Extract<BudgetClaim, { readonly go: false }>, lane: { readonly provider: string; readonly model: string }): string => {
    const accounts = claim.projections.map(standingWords).join(`; `);
    return (
        `it waits for room: no ${lane.provider} account carries one more ${lane.model} child through its allowance windows right now (${accounts}). ` +
        `It starts by itself, on the account with most room, when one of the running ones ends, a reading shows room again, or the window that holds it reopens`
    );
};

/** Where a child that goes was placed, when the planner placed it or let it go short; undefined for nothing worth saying. */
export const budgetPlacedWords = (claim: Extract<BudgetClaim, { readonly go: true }>): string | undefined => {
    const projection = claim.projection;
    if (projection === undefined) {
        return undefined;
    }
    if (claim.short === true) {
        return `It started on ${standingWords(projection)} although no account carries it through its windows: nothing else of yours runs on that provider, so it goes rather than wait on an estimate. Expect it to be stopped when the window empties.`;
    }
    return claim.account === undefined ? undefined : `Placed on ${standingWords(projection)}, the account left with the most room after it.`;
};

/** The provider's budget for children of a model, as the spawn listing says it. */
export const forecastWords = (forecast: BudgetForecast, model: string): string => {
    const each = forecast.projections.map(standingWords).join(`; `);
    const more =
        forecast.more === 0
            ? `no more ${model} children fit through their windows now: any you start wait as pending until room is back`
            : `about ${String(forecast.more)} more ${model} children fit now; any past that wait as pending and start as room comes back`;
    return `budget: ${each}; ${more} (each estimated at ${hoursWords(forecast.plan.child.hours)} of work)`;
};
