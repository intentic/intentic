import type { DesiredStateGraph } from "@intentic/graph";

// Golden expected output for ../deploy.config.ts — regenerated from the compiled graph. Captures the
// users/teams identity nodes (Forgejo accounts + org/team, Komodo users + per-deployment grants) and the
// CI/CD wiring: per-environment `ci` nodes + Komodo `deployment` nodes pointed at the registry image under
// the owning team org. The engine-side control-plane API nodes (repo/ci/deployment/identities/notify) carry
// the CP host's ssh block — they reach Forgejo/Komodo over an SSH port-forward, never the public routes.
// Guarded by the topo-order, ref-edge, and secret tests.
export const expectedGraph: DesiredStateGraph = {
    "version": 1,
    "resources": {
        "host": {
            "id": "host",
            "type": "host",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                }
            },
            "dependsOn": []
        },
        "cf": {
            "id": "cf",
            "type": "cloudflare",
            "inputs": {
                "apiToken": {
                    "$secret": {
                        "source": "env",
                        "key": "CLOUDFLARE_API_TOKEN"
                    }
                },
                "zone": "example.com"
            },
            "dependsOn": []
        },
        "host-git": {
            "id": "host-git",
            "type": "forgejo",
            "inputs": {
                "server": {
                    "$ref": "host"
                },
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "internalIp": {
                    "$ref": "host.internalIp"
                },
                "domain": "git.example.com",
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                },
                "image": "codeberg.org/forgejo/forgejo:15.0.3@sha256:55bb42bec9abef5223744804f164e37d37b20df7e8b8b4807ba213ad4f071d6d"
            },
            "dependsOn": [
                "host"
            ],
            "readyWhen": {
                "check": "httpOk",
                "url": {
                    "$ref": "host-git.internalUrl"
                },
                "timeout": "120s"
            }
        },
        "host-git-runner": {
            "id": "host-git-runner",
            "type": "forgejo-runner",
            "inputs": {
                "server": {
                    "$ref": "host"
                },
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "instanceUrl": {
                    "$ref": "host-git.internalUrl"
                },
                "token": {
                    "$ref": "host-git.runnerToken"
                },
                "image": "data.forgejo.org/forgejo/runner:12.12.0@sha256:268ad0d1d24bd7ecf2386b7c44e8211398dc014ca81d4fd5fbad96fe79af18f5",
                "jobImage": "data.forgejo.org/oci/node:24-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be"
            },
            "dependsOn": [
                "host",
                "host-git"
            ]
        },
        "host-deploy": {
            "id": "host-deploy",
            "type": "komodo",
            "inputs": {
                "server": {
                    "$ref": "host"
                },
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "internalIp": {
                    "$ref": "host.internalIp"
                },
                "domain": "deploy.example.com",
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "KOMODO_ADMIN_PASSWORD"
                    }
                },
                "gitUrl": {
                    "$ref": "host-git.internalUrl"
                },
                "gitAccount": "intentic",
                "gitToken": {
                    "$ref": "host-git.gitToken"
                },
                "registry": "git.example.com",
                "registryUser": "intentic",
                "registryToken": {
                    "$ref": "host-git.packagesToken"
                },
                "coreImage": "ghcr.io/moghtech/komodo-core:2.1.0@sha256:4915d91b5c6e9de4e8fd59391eed5cad090ec84dcf6a1a9233d97edfdbbb88e7",
                "peripheryImage": "ghcr.io/moghtech/komodo-periphery:2.1.0@sha256:f5b272e3d9acd60d4eac69ea4fa0292dcaddfdecfc2be64ba5575e5ae18e72ae",
                "ferretdbImage": "ghcr.io/ferretdb/ferretdb:2.7.0@sha256:5706414241eb84f0515512c37b46db0f1b1eac9e5ceb7e4c2523211c184b1985",
                "postgresImage": "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0@sha256:2386795ec2aa7ae559304361979f1dc5708d383ee9020ae63dadc2940dfe58f7"
            },
            "dependsOn": [
                "host",
                "host-git"
            ],
            "readyWhen": {
                "check": "httpOk",
                "url": {
                    "$ref": "host-deploy.internalUrl"
                },
                "timeout": "90s"
            }
        },
        "cf-git-example-com": {
            "id": "cf-git-example-com",
            "type": "cf-route",
            "inputs": {
                "hostname": "git.example.com",
                "zoneId": {
                    "$ref": "cf.zoneId"
                },
                "apiToken": {
                    "$secret": {
                        "source": "env",
                        "key": "CLOUDFLARE_API_TOKEN"
                    }
                },
                "cname": {
                    "$ref": "host-tunnel.cname"
                }
            },
            "dependsOn": [
                "cf",
                "host-tunnel"
            ]
        },
        "cf-deploy-example-com": {
            "id": "cf-deploy-example-com",
            "type": "cf-route",
            "inputs": {
                "hostname": "deploy.example.com",
                "zoneId": {
                    "$ref": "cf.zoneId"
                },
                "apiToken": {
                    "$secret": {
                        "source": "env",
                        "key": "CLOUDFLARE_API_TOKEN"
                    }
                },
                "cname": {
                    "$ref": "host-tunnel.cname"
                }
            },
            "dependsOn": [
                "cf",
                "host-tunnel"
            ]
        },
        "my-app-repo": {
            "id": "my-app-repo",
            "type": "repo",
            "inputs": {
                "name": "my-app",
                "owner": "squad",
                "private": true,
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "domain": "git.example.com",
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                }
            },
            "dependsOn": [
                "host-git",
                "host-git-org-squad"
            ]
        },
        "my-app.staging-ci": {
            "id": "my-app.staging-ci",
            "type": "ci",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                },
                "komodoPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "KOMODO_ADMIN_PASSWORD"
                    }
                },
                "owner": "squad",
                "repoName": "my-app",
                "branch": "develop",
                "registry": "git.example.com",
                "tag": "staging",
                "packagesToken": {
                    "$ref": "host-git.packagesToken"
                },
                "komodoUrl": {
                    "$ref": "host-deploy.internalUrl"
                },
                "deployment": "my-app.staging"
            },
            "dependsOn": [
                "host-git",
                "host-deploy",
                "my-app-repo",
                "host-git-org-squad"
            ]
        },
        "my-app.staging": {
            "id": "my-app.staging",
            "type": "deployment",
            "inputs": {
                "owner": "squad",
                "repoName": "my-app",
                "registry": "git.example.com",
                "registryAccount": "intentic",
                "tag": "staging",
                "domain": "staging.example.com",
                "internalIp": {
                    "$ref": "host.internalIp"
                },
                "port": 27748,
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "KOMODO_ADMIN_PASSWORD"
                    }
                },
                "env": {
                    "DATABASE_URL": {
                        "$secret": {
                            "source": "env",
                            "key": "STAGING_DATABASE_URL"
                        }
                    }
                }
            },
            "dependsOn": [
                "my-app.staging-ci",
                "host-deploy",
                "host"
            ]
        },
        "cf-staging-example-com": {
            "id": "cf-staging-example-com",
            "type": "cf-route",
            "inputs": {
                "hostname": "staging.example.com",
                "zoneId": {
                    "$ref": "cf.zoneId"
                },
                "apiToken": {
                    "$secret": {
                        "source": "env",
                        "key": "CLOUDFLARE_API_TOKEN"
                    }
                },
                "cname": {
                    "$ref": "host-tunnel.cname"
                }
            },
            "dependsOn": [
                "cf",
                "host-tunnel"
            ]
        },
        "my-app.production-ci": {
            "id": "my-app.production-ci",
            "type": "ci",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                },
                "komodoPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "KOMODO_ADMIN_PASSWORD"
                    }
                },
                "owner": "squad",
                "repoName": "my-app",
                "branch": "main",
                "registry": "git.example.com",
                "tag": "production",
                "packagesToken": {
                    "$ref": "host-git.packagesToken"
                },
                "komodoUrl": {
                    "$ref": "host-deploy.internalUrl"
                },
                "deployment": "my-app.production"
            },
            "dependsOn": [
                "host-git",
                "host-deploy",
                "my-app-repo",
                "host-git-org-squad"
            ]
        },
        "my-app.production": {
            "id": "my-app.production",
            "type": "deployment",
            "inputs": {
                "owner": "squad",
                "repoName": "my-app",
                "registry": "git.example.com",
                "registryAccount": "intentic",
                "tag": "production",
                "domain": "app.example.com",
                "internalIp": {
                    "$ref": "host.internalIp"
                },
                "port": 23104,
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "KOMODO_ADMIN_PASSWORD"
                    }
                },
                "env": {
                    "DATABASE_URL": {
                        "$secret": {
                            "source": "env",
                            "key": "PRODUCTION_DATABASE_URL"
                        }
                    }
                }
            },
            "dependsOn": [
                "my-app.production-ci",
                "host-deploy",
                "host"
            ]
        },
        "cf-app-example-com": {
            "id": "cf-app-example-com",
            "type": "cf-route",
            "inputs": {
                "hostname": "app.example.com",
                "zoneId": {
                    "$ref": "cf.zoneId"
                },
                "apiToken": {
                    "$secret": {
                        "source": "env",
                        "key": "CLOUDFLARE_API_TOKEN"
                    }
                },
                "cname": {
                    "$ref": "host-tunnel.cname"
                }
            },
            "dependsOn": [
                "cf",
                "host-tunnel"
            ]
        },
        "host-git-user-dev": {
            "id": "host-git-user-dev",
            "type": "forgejo-user",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                },
                "username": "dev",
                "email": "dev@example.com",
                "accountPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "INTENTIC_USER_PASSWORD_DEV"
                    }
                }
            },
            "dependsOn": [
                "host-git"
            ]
        },
        "host-deploy-user-dev": {
            "id": "host-deploy-user-dev",
            "type": "komodo-user",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "KOMODO_ADMIN_PASSWORD"
                    }
                },
                "username": "dev",
                "password": {
                    "$secret": {
                        "source": "generated",
                        "key": "INTENTIC_USER_PASSWORD_DEV"
                    }
                },
                "grants": [
                    {
                        "deployment": "my-app.staging",
                        "level": "Execute"
                    },
                    {
                        "deployment": "my-app.production",
                        "level": "Execute"
                    }
                ]
            },
            "dependsOn": [
                "host-deploy",
                "my-app.staging",
                "my-app.production"
            ]
        },
        "host-git-org-squad": {
            "id": "host-git-org-squad",
            "type": "forgejo-org",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                },
                "org": "squad"
            },
            "dependsOn": [
                "host-git"
            ]
        },
        "host-git-org-squad-team": {
            "id": "host-git-org-squad-team",
            "type": "forgejo-team",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "adminUser": "intentic",
                "adminPassword": {
                    "$secret": {
                        "source": "generated",
                        "key": "FORGEJO_ADMIN_PASSWORD"
                    }
                },
                "org": "squad",
                "name": "members",
                "permission": "write",
                "members": [
                    "dev"
                ],
                "repos": [
                    {
                        "owner": "squad",
                        "name": "my-app"
                    }
                ]
            },
            "dependsOn": [
                "host-git-org-squad",
                "host-git-user-dev",
                "my-app-repo"
            ]
        },
        "host-backup": {
            "id": "host-backup",
            "type": "backup",
            "inputs": {
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "repo": "/repo",
                "password": {
                    "$secret": {
                        "source": "generated",
                        "key": "RESTIC_PASSWORD"
                    }
                },
                "signoz": false,
                "image": "restic/restic:0.19.0@sha256:7f44e0057b82348597568ea209360762d0b38f8e1dbc8ad859661ac1055e45f2"
            },
            "dependsOn": [
                "host-git",
                "host-deploy"
            ]
        },
        "host-tunnel": {
            "id": "host-tunnel",
            "type": "tunnel",
            "inputs": {
                "name": "intentic-host",
                "accountId": {
                    "$ref": "cf.accountId"
                },
                "apiToken": {
                    "$secret": {
                        "source": "env",
                        "key": "CLOUDFLARE_API_TOKEN"
                    }
                },
                "address": "203.0.113.10",
                "user": "deploy",
                "sshKey": {
                    "$secret": {
                        "source": "env",
                        "key": "HOST_SSH_KEY"
                    }
                },
                "ingress": [
                    {
                        "hostname": "git.example.com",
                        "port": 3000
                    },
                    {
                        "hostname": "deploy.example.com",
                        "port": 9120
                    },
                    {
                        "hostname": "staging.example.com",
                        "port": 27748
                    },
                    {
                        "hostname": "app.example.com",
                        "port": 23104
                    }
                ],
                "image": "cloudflare/cloudflared:2026.6.1@sha256:6d91c121b803126f7a5344005d17a9324788fc09d305b6e2560ec6040a7ae283"
            },
            "dependsOn": [
                "cf",
                "host"
            ]
        }
    }
};
