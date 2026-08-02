-- CreateTable
CREATE TABLE "desktop_handoff" (
    "id" TEXT NOT NULL,
    "ott" TEXT NOT NULL,
    "idToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_handoff_pkey" PRIMARY KEY ("id")
);
