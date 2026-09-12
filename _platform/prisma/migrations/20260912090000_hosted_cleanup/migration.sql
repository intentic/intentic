CREATE TABLE "hosted_cleanup" (
    "appName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hosted_cleanup_pkey" PRIMARY KEY ("appName")
);
