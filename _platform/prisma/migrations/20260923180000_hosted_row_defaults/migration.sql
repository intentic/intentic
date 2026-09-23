-- Every writer states the rung, the CPU kind and the pool identity, so no column supplies a fallback.
ALTER TABLE "hosted_machine" ALTER COLUMN "tier" DROP DEFAULT;
ALTER TABLE "hosted_machine" ALTER COLUMN "cpuKind" DROP DEFAULT;
ALTER TABLE "hosted_pool_machine" ALTER COLUMN "token" DROP DEFAULT;
