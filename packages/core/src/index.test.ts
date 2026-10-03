import { expect, test } from "vitest";
import { SERVICE_NAME } from "./index.ts";

test("exports the service name", () => {
  expect(SERVICE_NAME).toBe("irs-lookup");
});
