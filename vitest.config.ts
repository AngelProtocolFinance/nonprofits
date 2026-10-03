import { configDefaults, defineConfig } from "vitest/config";

const WORKERD_TESTS = "packages/{worker,cli}/test/**/*.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/{src,test}/**/*.test.ts"],
          exclude: [...configDefaults.exclude, WORKERD_TESTS],
        },
      },
      {
        // Every file here boots workerd (a harness or a wrangler child
        // process), and the gate runs them side by side: the 5 s test and 10 s
        // hook defaults time out on a loaded runner. 60 s also covers the up
        // to 31 s `clearOfUtcMidnight` sleeps inside a test.
        test: {
          name: "workerd",
          include: [WORKERD_TESTS],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
