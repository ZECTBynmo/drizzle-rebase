-- Make email NOT NULL after backfill
UPDATE "users" SET "email" = 'unknown@example.com' WHERE "email" IS NULL;
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;
