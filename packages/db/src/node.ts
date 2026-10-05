// Node-only: the libSQL driver and the migration runner. The package root may
// only `import type` from @libsql/client and never import node:*, so a runtime
// entry can open its client from whichever @libsql/client build it takes;
// whatever needs either at runtime is exported here.
export {
  type AppDbEnv,
  appDbClient,
  type DataDbEnv,
  dataDbClient,
} from "./client.ts";
export { migrateAppDb } from "./migrate.ts";
