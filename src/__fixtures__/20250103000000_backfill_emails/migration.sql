UPDATE "users" SET "email" = lower("name") || '@example.com' WHERE "email" IS NULL;
