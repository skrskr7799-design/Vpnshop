import { describe, expect, it } from "vitest";
import { addMonths } from "../remnawave/remnawave.dates";

describe("UTC calendar v1", () => {
  it.each([
    ["2028-01-31T23:59:30.123Z", 1, "2028-02-29T23:59:30.123Z"],
    ["2027-01-31T23:59:30.123Z", 1, "2027-02-28T23:59:30.123Z"],
    ["2027-05-31T07:05:00.001Z", 3, "2027-08-31T07:05:00.001Z"],
    ["2027-06-10T08:00:00.000Z", 6, "2027-12-10T08:00:00.000Z"],
  ] as const)("adds %s plus %d months", (input, months, result) => {
    expect(addMonths(new Date(input), months).toISOString()).toBe(result);
  });
  it("distinguishes one three-month purchase from three individual periods", () => {
    const january = new Date("2027-01-31T12:34:56.789Z");
    expect(addMonths(january, 3).toISOString()).toBe("2027-04-30T12:34:56.789Z");
    expect([1, 1, 1].reduce(current => addMonths(current, 1), january).toISOString())
      .toBe("2027-04-28T12:34:56.789Z");
  });
});
