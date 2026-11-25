import { describe, expect, it } from "vitest";
import { parseSiren } from "./siren";

describe("parseSiren", () => {
  it("accepts 9 digits", () => {
    expect(parseSiren("900997767")).toBe("900997767");
  });

  it.each([[""], ["90099776"], ["9009977670"], ["900 997 767"], ["900997767\n"], ["' or ''='"]])(
    "refuses %j",
    (input) => {
      expect(() => parseSiren(input)).toThrow("Not a SIREN");
    },
  );
});
