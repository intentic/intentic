import { generated, makeRef } from "@intentic/graph";
import type { ForgejoRole, IntentSet, KomodoRole } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import {
    adminUsername,
    deploymentId,
    forgejoOrgId,
    forgejoTeamId,
    forgejoUserId,
    komodoUserId,
    orgName,
    repoId,
    userPasswordKey,
} from "../lib/ids.js";
import type { PlatformRefs } from "./platform.js";

// The people + teams resolver: a Forgejo git account and a Komodo UI user per declared user, and a Forgejo
// organization + team per declared team. It also wires the cross-cutting grant graph that only exists once all
// apps are known — which repos a team is attached to (and at what role), and which deployments a user can act
// on in Komodo (and at what level). Authenticates every call as the single admin (it owns the orgs, so its
// git + packages tokens retain full access); each user's login password is one intentic-generated secret,
// reused for both the Forgejo and Komodo account.

// The single Forgejo team name inside each org. A "team" maps to one org with one members team in it.
const TEAM_NAME = "members";

// Forgejo role precedence: a Forgejo team carries ONE permission applied to all its repos, but an app may grant
// a team at a different role than another app does. The strongest grant wins, so a team never loses access it
// was granted elsewhere.
const forgejoRoleRank: Readonly<Record<ForgejoRole, number>> = { read: 1, write: 2, admin: 3 };
const strongerForgejoRole = (a: ForgejoRole, b: ForgejoRole): ForgejoRole => (forgejoRoleRank[a] >= forgejoRoleRank[b] ? a : b);

// The Komodo permission level a team's role maps to, and its precedence for the same dedup reason (a user in
// two teams that both grant the same deployment gets the strongest level).
const komodoLevel: Readonly<Record<KomodoRole, "Read" | "Execute" | "Write">> = { read: "Read", execute: "Execute", admin: "Write" };
const komodoLevelRank: Readonly<Record<"Read" | "Execute" | "Write", number>> = { Read: 1, Execute: 2, Write: 3 };

interface RepoGrant {
    readonly owner: string;
    readonly name: string;
}

export const resolveIdentities = (intent: IntentSet, platform: PlatformRefs, hostId: string): ResolvedNode[] => {
    const forgejoUrl = makeRef<string>(platform.forgejo, "url");
    const komodoUrl = makeRef<string>(platform.deploy, "url");
    const forgejoAdmin = { adminUser: adminUsername, adminPassword: generated("FORGEJO_ADMIN_PASSWORD") };
    const komodoAdmin = { adminUser: adminUsername, adminPassword: generated("KOMODO_ADMIN_PASSWORD") };

    const userById = new Map(intent.users.map((user) => [user.id, user.input]));
    const teamById = new Map(intent.teams.map((team) => [team.id, team.input]));

    // Validate references up front (matches emit's app.observe -> service check), so a typo fails here with a
    // clear message rather than as a dangling dependency the compiler rejects.
    for (const team of intent.teams) {
        for (const member of team.input.members) {
            if (!userById.has(member)) {
                throw new Error(`team "${team.id}" references unknown user "${member}"; declare it with i.want.user`);
            }
        }
    }
    for (const app of intent.apps) {
        for (const grant of app.teams ?? []) {
            if (!teamById.has(grant.team)) {
                throw new Error(`app "${app.id}" grants unknown team "${grant.team}"; declare it with i.want.team`);
            }
        }
    }

    // Per team: its effective Forgejo permission (strongest grant) and the repos it is attached to. Per user:
    // the strongest Komodo level on each deployment it can reach through its teams. Built by walking every app
    // grant once.
    const teamPermission = new Map<string, ForgejoRole>();
    const teamRepos = new Map<string, RepoGrant[]>();
    const userGrants = new Map<string, Map<string, "Read" | "Execute" | "Write">>();
    const teamMembers = (teamId: string): readonly string[] => teamById.get(teamId)?.members ?? [];

    for (const app of intent.apps) {
        const grants = app.teams ?? [];
        const ownerGrant = grants[0];
        if (ownerGrant === undefined) {
            continue;
        }
        const owner = orgName(ownerGrant.team);
        const deployments = Object.keys(app.environments).map((environment) => deploymentId(app.id, environment));
        for (const grant of grants) {
            const current = teamPermission.get(grant.team);
            teamPermission.set(grant.team, current === undefined ? grant.role : strongerForgejoRole(current, grant.role));
            const repos = teamRepos.get(grant.team) ?? [];
            repos.push({ owner, name: app.id });
            teamRepos.set(grant.team, repos);

            const level = komodoLevel[teamById.get(grant.team)?.komodo ?? "read"];
            for (const member of teamMembers(grant.team)) {
                const grantsForUser = userGrants.get(member) ?? new Map<string, "Read" | "Execute" | "Write">();
                for (const deployment of deployments) {
                    const existing = grantsForUser.get(deployment);
                    if (existing === undefined || komodoLevelRank[level] > komodoLevelRank[existing]) {
                        grantsForUser.set(deployment, level);
                    }
                }
                userGrants.set(member, grantsForUser);
            }
        }
    }

    const nodes: ResolvedNode[] = [];

    for (const user of intent.users) {
        const grants = [...(userGrants.get(user.id) ?? new Map()).entries()].map(([deployment, level]) => ({ deployment, level }));
        nodes.push({
            id: forgejoUserId(hostId, user.id),
            type: "forgejo-user",
            inputs: {
                forgejoUrl,
                ...forgejoAdmin,
                username: user.input.username,
                email: user.input.email,
                accountPassword: generated(userPasswordKey(user.id)),
            },
            explicitDependsOn: [platform.forgejo, platform.gitRoute],
        });
        nodes.push({
            id: komodoUserId(hostId, user.id),
            type: "komodo-user",
            inputs: { komodoUrl, ...komodoAdmin, username: user.input.username, password: generated(userPasswordKey(user.id)), grants },
            // The Komodo account + its per-deployment permissions; depends on each scoped deployment existing.
            explicitDependsOn: [platform.deploy, platform.deployRoute, ...grants.map((grant) => grant.deployment)],
        });
    }

    for (const team of intent.teams) {
        const org = orgName(team.id);
        const repos = teamRepos.get(team.id) ?? [];
        nodes.push({
            id: forgejoOrgId(hostId, team.id),
            type: "forgejo-org",
            inputs: { forgejoUrl, ...forgejoAdmin, org },
            explicitDependsOn: [platform.forgejo, platform.gitRoute],
        });
        nodes.push({
            id: forgejoTeamId(hostId, team.id),
            type: "forgejo-team",
            inputs: {
                forgejoUrl,
                ...forgejoAdmin,
                org,
                name: TEAM_NAME,
                permission: teamPermission.get(team.id) ?? "read",
                members: team.input.members.map((member) => userById.get(member)?.username ?? member),
                repos,
            },
            // After the org, every member's account, and every repo it is attached to.
            explicitDependsOn: [
                forgejoOrgId(hostId, team.id),
                ...team.input.members.map((member) => forgejoUserId(hostId, member)),
                ...repos.map((repo) => repoId(repo.name)),
            ],
        });
    }

    return nodes;
};
