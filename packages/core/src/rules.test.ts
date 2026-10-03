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

describe("isRevoked", () => {
  test("is false when not on the revocation list", () => {
    expect(isRevoked({ revokedOn: null, reinstatedOn: null })).toBe(false);
  });
  test("is true when revoked and not reinstated", () => {
    expect(isRevoked({ revokedOn: "2023-05-15", reinstatedOn: null })).toBe(
      true,
    );
  });
  test("is false when reinstated after the revocation", () => {
    expect(
      isRevoked({ revokedOn: "2020-05-15", reinstatedOn: "2021-02-01" }),
    ).toBe(false);
  });
  test("is true when revoked again after a reinstatement", () => {
    expect(
      isRevoked({ revokedOn: "2024-05-15", reinstatedOn: "2021-02-01" }),
    ).toBe(true);
  });
  test("is unknown before the revocation list is imported", () => {
    expect(isRevoked(null)).toBeNull();
  });
});
