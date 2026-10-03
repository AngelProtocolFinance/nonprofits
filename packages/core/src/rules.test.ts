import { describe, expect, test } from "vitest";
import { is501c3, isDeductible, isRevoked } from "./rules.ts";

describe("is501c3", () => {
  test("is true for BMF subsection 03", () => {
    expect(is501c3({ subsection: "03" })).toBe(true);
  });
  test("is false for any other subsection", () => {
    expect(is501c3({ subsection: "04" })).toBe(false);
  });
  test("is unknown without a BMF row", () => {
    expect(is501c3(null)).toBeNull();
  });
});

describe("isDeductible", () => {
  test("follows the Pub 78 listing", () => {
    expect(isDeductible({ listed: true })).toBe(true);
    expect(isDeductible({ listed: false })).toBe(false);
  });
  test("is unknown before Pub 78 is imported", () => {
    expect(isDeductible(null)).toBeNull();
  });
});

const NO_RULING = { rulingDate: null };

describe("isRevoked", () => {
  test("is false when not on the revocation list", () => {
    expect(isRevoked({ revokedOn: null, reinstatedOn: null }, NO_RULING)).toBe(
      false,
    );
  });
  test("is true when revoked and not reinstated", () => {
    expect(
      isRevoked({ revokedOn: "2023-05-15", reinstatedOn: null }, NO_RULING),
    ).toBe(true);
  });
  test("is false when reinstated after the revocation", () => {
    expect(
      isRevoked(
        { revokedOn: "2020-05-15", reinstatedOn: "2021-02-01" },
        NO_RULING,
      ),
    ).toBe(false);
  });
  test("is true when revoked again after a reinstatement", () => {
    expect(
      isRevoked(
        { revokedOn: "2024-05-15", reinstatedOn: "2021-02-01" },
        NO_RULING,
      ),
    ).toBe(true);
  });
  test("is unknown before the revocation list is imported", () => {
    expect(isRevoked(null, { rulingDate: "2026-07" })).toBeNull();
  });
  test("is false when the BMF ruling month is after the revocation", () => {
    expect(
      isRevoked(
        { revokedOn: "2025-09-15", reinstatedOn: null },
        { rulingDate: "2025-10" },
      ),
    ).toBe(false);
  });
  test.each(["2025-09", "2019-03"])(
    "is true when the BMF ruling month is %s, not after a 2025-09 revocation",
    (rulingDate) => {
      expect(
        isRevoked(
          { revokedOn: "2025-09-15", reinstatedOn: null },
          { rulingDate },
        ),
      ).toBe(true);
    },
  );
  test("is true when revoked and absent from the BMF", () => {
    expect(
      isRevoked({ revokedOn: "2025-09-15", reinstatedOn: null }, null),
    ).toBe(true);
  });
});
