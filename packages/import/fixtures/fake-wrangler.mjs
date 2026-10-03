// Stands in for wrangler's bin in the process tests: does what $FAKE_WRANGLER says.
import { writeFileSync } from "node:fs";

const plan = JSON.parse(process.env.FAKE_WRANGLER ?? "{}");
if (plan.record) {
  writeFileSync(
    plan.record,
    JSON.stringify({
      argv: process.argv.slice(2),
      metrics: process.env.WRANGLER_SEND_METRICS,
    }),
  );
}
if (plan.stderr) process.stderr.write(plan.stderr);
if (plan.stdout) process.stdout.write(plan.stdout);
if (plan.hang) {
  // wrangler exits 0 on the SIGTERM that stops it
  process.on("SIGTERM", () => process.exit(0));
  // a fake the test failed to kill must not outlive it
  setTimeout(() => process.exit(3), 60_000);
} else {
  process.exitCode = plan.exit ?? 0;
}
