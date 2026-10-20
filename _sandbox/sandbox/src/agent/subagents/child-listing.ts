import { within } from "@intentic/base/async";
import { isIsolated } from "../../conversations/registry/agents-store.js";
import { landingPaths } from "../../conversations/land/landing-paths.js";
import type { Services } from "../../composition.js";
import { spawnBlocked, spawnCatalogText, type SpawnableProvider, spawnableProviders } from "./spawn-catalog.js";
import { mentionsSpentAllowance } from "../../engines/failure-sentences.js";
import { spentRung } from "../models/role-model-quota.js";
import type { LandResult } from "@intentic/sandbox-contract/schemas/agents";
import type { ChildActionResult, ChildSpawnSpec } from "./children.js";

// What the records say a child can still run on, and what a failed one leaves behind: the spawn preflight against a
// spent model, and the words that name a child's work and the doors that keep it.

// How long the allowance listing gets before whoever wanted it carries on without it. It probes every connected
// provider's readiness and catalog, which takes seconds; nothing that reads it here is worth stalling a settle or a
// refusal for, so a slow one simply goes unquoted.
const LISTING_MS = 3_000;

// The listing, or undefined when it failed or took too long. Never raises: every caller is composing a sentence, and a
// sentence without its alternatives still says what happened.
const listingWithin = async (services: Services, what: string): Promise<readonly SpawnableProvider[] | undefined> => {
    const read = async (): Promise<readonly SpawnableProvider[] | undefined> => {
        try {
            return await spawnableProviders(services);
        } catch (error) {
            services.logger.warn({ err: error, what }, "the allowance listing could not be read");
            return undefined;
        }
    };
    return within(read(), LISTING_MS, undefined, { unref: true });
};

// What a failed child's parent can do next, appended to the vendor's own sentence, which alone ("You're out of usage.
// Switch to Auto or Composer 2.5") leaves the parent a turn of working out where the work can go. It names what the
// child already did and the two doors that keep it: a move with `send` carries the work on in the same worktree, `merge`
// brings it in as it stands. Telling the parent to re-spawn instead cost it twelve replacement prompts and seven
// hand-copied patches when the work was a `send` away (2026-10-17). Only a spent allowance is worth the listing's round
// trips for where else; a listing that cannot be read leaves that half out. Never raises.
export const elsewhereFor = async (
    services: Services,
    childId: string,
    spec: ChildSpawnSpec | undefined,
    failure: string,
): Promise<string | undefined> => {
    if (spec === undefined) {
        return undefined;
    }
    const spent = mentionsSpentAllowance(failure);
    const [providers, work] = await Promise.all([spent ? listingWithin(services, "child failure") : undefined, workSoFar(services, childId)]);
    const room = (providers ?? [])
        .filter((provider) => provider.models.length > 0 && provider.id !== spec.provider)
        .map((provider) => `${provider.id}/${provider.models[0]?.id ?? ""}`)
        .slice(0, 4);
    const where =
        providers === undefined
            ? ``
            : room.length === 0
              ? ` Nothing else connected has measured room right now, so moving it would be refused too.`
              : ` With room right now: ${room.join(", ")} (\`agents providers\` for the rest).`;
    return `${work} send(child: "${childId}", message, provider, model) carries it on elsewhere in that worktree; merge(child: "${childId}") brings it into your checkout as it stands; a fresh spawn would start over.${where}`;
};

/** What a child already did, as its parent reads it before deciding where its task goes: files changed in its worktree. */
const workSoFar = async (services: Pick<Services, "agents" | "agentWorktrees" | "logger">, childId: string): Promise<string> => {
    const entry = services.agents.entry(childId);
    if (entry === undefined || !isIsolated(entry)) {
        return "Its work so far stays in its worktree.";
    }
    const paths = await landingPaths(services, entry, entry.placement.repos).catch((): readonly string[] => []);
    return paths.length === 0
        ? "It changed nothing yet."
        : `Its work so far stays in its worktree: ${String(paths.length)} ${paths.length === 1 ? "file" : "files"} changed (${namedPaths(paths)}).`;
};

// A model the records already call spent, refused before a seat is taken. Nothing validated a spawn against the
// allowance listing before this, so a fan-out onto a spent provider cost a spawn, a wait and a re-spawn for every child
// — five of them in 32 seconds on one occasion (2026-10-11). Advisory still where it has to be: only a model measured
// spent is refused, an unreadable listing refuses nothing, and the refusal names what can run so the retry is one call.
export const spentAsked = async (services: Services, asked: ChildSpawnSpec): Promise<string | undefined> => {
    // The catalog's default, which names no pool to judge.
    if (asked.model === "") {
        return undefined;
    }
    // One provider's own records, not the whole listing: `spawnableProviders` probes every connected provider's
    // readiness and catalog and takes seconds, which a fan-out would pay for every child. `spentRung` only ever says
    // spent, so an unmeasured model and a failed read both go ahead as before.
    const spent = await spentRung(services, { provider: asked.provider, model: asked.model });
    if (spent === undefined) {
        return undefined;
    }
    // Only now, on the rare refusal, is the full listing worth its round trips: it is what makes the retry one call.
    // The refusal stands on `spentRung`'s own reading either way, so a listing that cannot be read only costs it the
    // alternatives, never its clarity.
    const providers = await listingWithin(services, "spawn preflight");
    const elsewhere = providers === undefined ? undefined : spawnBlocked(providers, { provider: asked.provider, model: asked.model });
    const listing = providers === undefined ? `` : `\n\nConnected right now:\n${spawnCatalogText(providers)}`;
    return `${elsewhere ?? `${asked.provider}/${asked.model} is out of allowance: ${spent.reason}`}${listing}`;
};

// A path list as a parent reads it: the first few named, the rest counted.
const namedPaths = (paths: readonly string[]): string =>
    [
        paths
            .slice(0, 5)
            .map((path) => `\`${path}\``)
            .join(", "),
        ...(paths.length > 5 ? [`and ${paths.length - 5} more`] : []),
    ].join(" ");

// What a parent hears of a merge into `where`: in, in with markers to resolve, already there, or nothing written.
export const mergeOutcome = (result: LandResult, where: string, childId: string): ChildActionResult => {
    // Asked first: a land that wrote nothing is never "in your checkout now", whatever its books say.
    if (result.landed && !result.changed) {
        return { ok: true, note: `Nothing of it is outstanding: ${where} already holds its work.` };
    }
    if (result.landed) {
        const open = (result.resolving ?? []).flatMap(({ repo, paths }) => paths.map((path) => (repo === "root" ? path : `${repo}/${path}`)));
        return {
            ok: true,
            note:
                open.length === 0
                    ? `Its changes are in ${where} now.`
                    : `Its changes are in ${where} now, with conflict markers to resolve in ${namedPaths(open)}.`,
        };
    }
    const blocked = (result.conflicts ?? []).flatMap(({ repo, paths }) => paths.map(({ path }) => (repo === "root" ? path : `${repo}/${path}`)));
    return {
        ok: false,
        message: `Nothing was written: ${blocked.length === 0 ? "the merge could not run" : `${namedPaths(blocked)} could not take conflict markers (a binary, or uncommitted edits that keep changing)`}. Its work stays on its branch \`agent/${childId}\`.`,
    };
};
