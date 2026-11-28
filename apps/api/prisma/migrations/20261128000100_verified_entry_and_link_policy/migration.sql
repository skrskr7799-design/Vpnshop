ALTER TABLE "SessionFamily" ADD COLUMN "loginMethod" "AuthProvider";

CREATE TYPE "SubscriptionLinkPolicy" AS ENUM ('INHERIT', 'ALLOW', 'DENY');
ALTER TABLE "User" ADD COLUMN "subscriptionLinkPolicy" "SubscriptionLinkPolicy" NOT NULL DEFAULT 'INHERIT';
ALTER TABLE "AdminOperationalSettings" ADD COLUMN "subscriptionLinkAllowed" BOOLEAN NOT NULL DEFAULT true;
