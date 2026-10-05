// Node-only: the libSQL driver and the migration runner. The Worker bundles the
// package root, so the root may only `import type` from @libsql/client and
// never import node:*; whatever needs either at runtime is exported here.
export {
  type AppDbEnv,
  appDbClient,
  type DataDbEnv,
  dataDbClient,
} from "./client.ts";
export { migrateAppDb } from "./migrate.ts";
