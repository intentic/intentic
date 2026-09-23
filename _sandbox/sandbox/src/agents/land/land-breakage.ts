import { landBreakagePrompt } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { deliverWake } from "../../agent/run/turn/wake-delivery.js";
import { conversationProfile, reposOf } from "../registry/agents-store.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { LandBreakage } from "../../workspace/deps/verify-deps.js";

// A red land verdict's new failures go back to the one conversation whose land they appeared with, while it still holds
// the change; a breakage nobody can be named for is left to the repair queue rather than guessed at.

// Follow-ups one conversation is sent while one project stays red; past this the breakage is not its to keep chasing.
const SENDS_PER_STREAK = 2;
// Failures listed in the follow-up before the rest are counted.
const LISTED = 30;

// Sends per project and conversation since that project was last green; cleared by `breakageSettled`.
const sent = new Map<string, number>();
const sendKey = (project: string, conversationId: string): string => `${project}\n${conversationId}`;

// The first repository path a unit names; a task id (`@scope/name#task`) is a package name, never a path.
export const pathOfUnit = (unit: string): string | undefined =>
    unit
        .split(/\s+/)
        .map((word) => word.replace(/:$/, ""))
        .find((word) => word.includes("/") && !word.includes("#") && !word.startsWith("@"));

// The package a path sits in, `_area/package` in this layout; the whole path when it is shorter.
export const packageOf = (path: string): string => path.split("/").slice(0, 2).join("/");

// Lands whose own changes touch a package some fresh failure sits in; every land when no failure names a path.
export const suspectsOf = (fresh: readonly string[], lands: readonly { readonly land: DependencyLandOrigin; readonly paths: readonly string[] }[]): DependencyLandOrigin[] => {
    const named = new Set(fresh.flatMap((unit) => pathOfUnit(unit) ?? []).map(packageOf));
    if (named.size === 0) {
        return lands.map(({ land }) => land);
    }
    return lands.filter(({ paths }) => paths.some((path) => named.has(packageOf(path)))).map(({ land }) => land);
};

// What routing reads and knocks on: the owner's switch, the roster and its checkouts, and the doors a follow-up takes.
export type BreakageRouter = Pick<Services, "sandboxSettings" | "agents" | "agentWorktrees" | "activity" | "logger" | "turns" | "conversations">;

// What a land changed in the project's repository, from the commit it departed to the tip it landed.
const landedPaths = async (services: BreakageRouter, land: DependencyLandOrigin, project: string, git: GitRunner): Promise<string[]> => {
    const span = land.repos.find(({ repo }) => (repo === "root" ? "" : repo) === project);
    const entry = services.agents.entry(land.agentId);
    const tip = (entry === undefined ? [] : reposOf(entry)).find(({ repo }) => repo === span?.repo)?.landedTip;
    if (span === undefined || tip === undefined) {
        return [];
    }
    const { stdout } = await git(services.agentWorktrees.mainDir(span.repo), ["diff", "--name-only", "--no-renames", span.from, tip]).catch(() => ({ stdout: "" }));
    return stdout.split("\n").filter((path) => path !== "");
};

const promptFor = (breakage: LandBreakage): string =>
    landBreakagePrompt([
        `\`${breakage.command}\` in ${breakage.project === "" ? "the workspace root" : breakage.project} failed on:`,
        [...breakage.fresh.slice(0, LISTED).map((unit) => `- ${unit}`), ...(breakage.fresh.length > LISTED ? [`- …and ${breakage.fresh.length - LISTED} more`] : [])].join("\n"),
        `The end of its output:\n\n\`\`\`\n${breakage.logTail.trim()}\n\`\`\``,
    ]);

// The one land a breakage names, or undefined when it names none or several.
const namedLand = async (services: BreakageRouter, breakage: LandBreakage, git: GitRunner): Promise<DependencyLandOrigin | undefined> => {
    const suspects =
        breakage.lands.length === 1
            ? breakage.lands
            : suspectsOf(
                  breakage.fresh,
                  await Promise.all(breakage.lands.map(async (land) => ({ land, paths: await landedPaths(services, land, breakage.project, git) }))),
              );
    return suspects.length === 1 ? suspects[0] : undefined;
};

// Hands `breakage` to the one land it names; false when none or several are named, or that conversation is spent.
export const routeLandBreakage = async (services: BreakageRouter, breakage: LandBreakage, git: GitRunner = defaultGit): Promise<boolean> => {
    if (!(await services.sandboxSettings.get()).autoRepair) {
        return false;
    }
    const land = await namedLand(services, breakage, git);
    const entry = land === undefined ? undefined : services.agents.entry(land.agentId);
    if (land === undefined || entry === undefined || entry.archivedAt !== undefined) {
        return false;
    }
    const key = sendKey(breakage.project, land.agentId);
    const sends = sent.get(key) ?? 0;
    if (sends >= SENDS_PER_STREAK) {
        return false;
    }
    sent.set(key, sends + 1);
    void services.activity
        .append({
            direction: "system",
            type: "deps.breakage_routed",
            content: `${breakage.fresh.length} failure(s) appeared with this land; sent back to it to fix (${sends + 1} of ${SENDS_PER_STREAK}).`,
            outcome: "ok",
            conversationId: land.agentId,
            ...(land.title === undefined ? {} : { title: land.title }),
        })
        .catch((error: unknown) => services.logger.warn({ err: error }, "land breakage: activity append failed"));
    // A live conversation takes the words as a steer, an idle one is started, and a busy one queues them for its next turn.
    void deliverWake(
        { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
        { conversationId: land.agentId, prompt: promptFor(breakage), voice: "sandbox", profile: conversationProfile(entry) },
    ).then((receipt) => {
        if ("invalid" in receipt) {
            services.logger.warn({ conversationId: land.agentId, project: breakage.project, invalid: receipt.invalid }, "land breakage: the conversation could not take the follow-up");
        }
    });
    return true;
};

// A green project starts every conversation's count for it over.
export const breakageSettled = (project: string): void => {
    for (const key of sent.keys()) {
        if (key.startsWith(`${project}\n`)) {
            sent.delete(key);
        }
    }
};
