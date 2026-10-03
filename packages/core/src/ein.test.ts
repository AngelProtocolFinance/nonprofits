import { describe, expect, test } from "vitest";
import { normalizeEin } from "./ein.ts";

describe("normalizeEin", () => {
  test("accepts nine digits", () => {
    expect(normalizeEin("530196605")).toBe("530196605");
  });

  test("strips the hyphen after the two-digit prefix", () => {
    expect(normalizeEin("53-0196605")).toBe("530196605");
  });

  test.each(["abc", "53019660", "5301966050", "530-196605", "53-01966-05", ""])(
    "rejects %j",
    (input) => {
      expect(normalizeEin(input)).toBeNull();
    },
  );
});
