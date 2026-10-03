-- better-auth 1.7.7 core tables + @better-auth/api-key, from `auth generate`
-- (Kysely, SQLite). Edited only to declare STRICT: its `date` columns are TEXT
-- because the adapter writes them as ISO-8601 strings. The import never touches these.
CREATE TABLE "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" text not null,
  "updatedAt" text not null
) STRICT;

CREATE TABLE "session" (
  "id" text not null primary key,
  "expiresAt" text not null,
  "token" text not null unique,
  "createdAt" text not null,
  "updatedAt" text not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
) STRICT;

CREATE TABLE "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" text,
  "refreshTokenExpiresAt" text,
  "scope" text,
  "password" text,
  "createdAt" text not null,
  "updatedAt" text not null
) STRICT;

CREATE TABLE "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" text not null,
  "createdAt" text not null,
  "updatedAt" text not null
) STRICT;

CREATE TABLE "apikey" (
  "id" text not null primary key,
  "configId" text not null,
  "name" text,
  "start" text,
  "referenceId" text not null,
  "prefix" text,
  "key" text not null,
  "refillInterval" integer,
  "refillAmount" integer,
  "lastRefillAt" text,
  "enabled" integer,
  "rateLimitEnabled" integer,
  "rateLimitTimeWindow" integer,
  "rateLimitMax" integer,
  "requestCount" integer,
  "remaining" integer,
  "lastRequest" text,
  "expiresAt" text,
  "createdAt" text not null,
  "updatedAt" text not null,
  "permissions" text,
  "metadata" text
) STRICT;

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");

CREATE INDEX "apikey_configId_idx" on "apikey" ("configId");

CREATE INDEX "apikey_referenceId_idx" on "apikey" ("referenceId");

CREATE INDEX "apikey_key_idx" on "apikey" ("key");
