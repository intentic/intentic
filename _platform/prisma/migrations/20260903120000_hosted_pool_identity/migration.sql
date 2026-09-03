-- A hosted sandbox is reached by a Fly replay to its app rather than through a tunnel it dials, and the edge
-- derives that app's name from the sandbox id in the hostname with no lookup. That holds only if every hosted
-- app is named `<prefix>-<sandbox id>`, pool-born ones included — so a warm machine's identity (its connect
-- token, whose digest names the app) is minted when the machine is built and adopted by the sandbox row at
-- claim, instead of the row minting its own.
--
-- Both columns carry a DEFAULT so this applies to a database that has rows (check-migrations.sh, rule 2):
--   • `token` defaults to '' on the stock that exists today, which the pool reconcile reads as "no identity"
--     and replaces; the apps those rows name (`<prefix>-pool-<hex>`) go with them.
--   • `warm` records what the app name used to say, since a pool-born app is no longer named `pool`.

-- AlterTable
ALTER TABLE "hosted_pool_machine" ADD COLUMN "token" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "hosted_machine" ADD COLUMN "warm" BOOLEAN NOT NULL DEFAULT false;
