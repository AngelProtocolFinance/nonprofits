import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { authOptions } from "./src/auth.ts";

// `auth generate` only: the CLI can't reach D1, so it diffs against an empty SQLite
export const auth = betterAuth({
  ...authOptions,
  database: new DatabaseSync(":memory:"),
  secret: "generate-only-not-a-secret-0123456789abcdef",
});
