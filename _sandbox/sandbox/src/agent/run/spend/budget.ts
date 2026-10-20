/* WHETHER AN ACCOUNT CAN CARRY ONE MORE AGENT, with no I/O: the projection the fan-out planner (budget-planner.ts)
   places children by and holds them on.

   Ten Opus children went onto one account in four minutes because each spawn read the same figure, "84% left", and
   nothing counted the ones already headed there; the five-hour window was empty in fifty minutes (2026-10-20). What
   that figure could carry was knowable: about eight points an hour an agent, so thirteen agents had an hour of it, and
   the children needed more than that. A projection asks it of every window the model spends:

     usable  = points left, less the owner's reserve
     burn    = (what runs on the account now + the child) / what one point costs      points an hour
     horizon = the sooner of the window's reset and the child's expected run
     fits    = burn × horizon ≤ usable

   A window that resets before the child would finish only has to last until then: it refills. Every figure in here is
   an estimate, which is why a child that does not fit waits rather than is refused, and why one always goes where
   nothing of its parent's kind runs (budget-planner.ts). */

/** One window an account's model spends, as a projection reads it. */
export interface BudgetWindow {
    readonly kind: string;
    // As a person names it ("five-hour", "weekly"), for the words.
    readonly pool?: string | undefined;
    // 100 less its utilization: points of 100 still to spend.
    readonly leftPoints: number;
    // Hours until it reopens; undefined where nothing said (a window that opens on its first use).
    readonly resetsInHours?: number | undefined;
    // What one point costs in meter units: learned for the account, or the planner's prior.
    readonly tokensPerPoint: number;
}

export interface BudgetAccount {
    readonly id: string;
    readonly label?: string | undefined;
    readonly windows: readonly BudgetWindow[];
    // What the turns running on it spend an hour, the children already placed on it included.
    readonly loadTokensPerHour: number;
    // How many turns that is, for the words.
    readonly agents: number;
}

/** What one more child is expected to cost: its model's pace, and how long it is expected to run. */
export interface ChildCost {
    readonly tokensPerHour: number;
    readonly hours: number;
}

export interface WindowProjection {
    readonly window: BudgetWindow;
    readonly usable: number;
    // Points an hour with the child on it.
    readonly burn: number;
    readonly need: number;
    // Hours until it is empty at that burn; undefined for no burn.
    readonly lastsHours: number | undefined;
    readonly fits: boolean;
}

export interface Projection {
    readonly account: BudgetAccount;
    readonly fits: boolean;
    // The share of the tightest window's usable points left once the child's horizon is spent; negative when it does not fit.
    readonly margin: number;
    // The window that decides it: the one with the least margin.
    readonly binding: WindowProjection | undefined;
    readonly windows: readonly WindowProjection[];
}

const projectWindow = (window: BudgetWindow, loadTokensPerHour: number, child: ChildCost, reserve: number): WindowProjection => {
    const usable = Math.max(0, window.leftPoints - reserve);
    const burn = (loadTokensPerHour + child.tokensPerHour) / Math.max(1, window.tokensPerPoint);
    const horizon = Math.min(window.resetsInHours ?? Number.POSITIVE_INFINITY, child.hours);
    const need = burn * Math.max(0, horizon);
    return { window, usable, burn, need, lastsHours: burn > 0 ? usable / burn : undefined, fits: need <= usable };
};

const marginOf = (projection: WindowProjection): number => (projection.usable - projection.need) / Math.max(1, projection.usable);

/** Whether the account carries what runs on it plus one child like this through every window the child spends. */
export const project = (account: BudgetAccount, child: ChildCost, reserve: number): Projection => {
    const windows = account.windows.map((window) => projectWindow(window, account.loadTokensPerHour, child, reserve));
    const binding = windows.reduce<WindowProjection | undefined>((tightest, next) => (tightest === undefined || marginOf(next) < marginOf(tightest) ? next : tightest), undefined);
    return {
        account,
        fits: windows.every((window) => window.fits),
        // An account no window meters carries anything as far as the figures know.
        margin: binding === undefined ? 1 : marginOf(binding),
        binding,
        windows,
    };
};

/** The account a child should go on: of those that carry it, the one left with the most room; undefined when none does. */
export const choose = (accounts: readonly BudgetAccount[], child: ChildCost, reserve: number): Projection | undefined =>
    accounts
        .map((account) => project(account, child, reserve))
        .filter((projection) => projection.fits)
        .reduce<Projection | undefined>((best, next) => (best === undefined || next.margin > best.margin ? next : best), undefined);

/** The account that holds out longest if a child goes anyway: what the one start nothing may hold back is placed on. */
export const leastShort = (accounts: readonly BudgetAccount[], child: ChildCost, reserve: number): Projection | undefined =>
    accounts
        .map((account) => project(account, child, reserve))
        .reduce<Projection | undefined>((best, next) => (best === undefined || next.margin > best.margin ? next : best), undefined);

// A fan-out past this is past anything a parent asks for at once; the count stops here rather than loop on a figure
// that measures nothing.
const MOST_COUNTED = 50;

/** How many more children like this one the accounts carry between them, each placed where the last left most room. */
export const capacity = (accounts: readonly BudgetAccount[], child: ChildCost, reserve: number): number => {
    let loaded = [...accounts];
    let count = 0;
    for (; count < MOST_COUNTED; count += 1) {
        const best = choose(loaded, child, reserve);
        if (best === undefined) {
            break;
        }
        loaded = loaded.map((account) =>
            account.id === best.account.id ? { ...account, loadTokensPerHour: account.loadTokensPerHour + child.tokensPerHour, agents: account.agents + 1 } : account,
        );
    }
    return count;
};
