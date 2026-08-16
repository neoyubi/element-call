import { describe, expect, it } from "vitest";

import { formatDate, formatTime, parseStart } from "./dateFormat";

// Pinned to a zone with daylight saving: 29 March 2026 has no 02:30 locally.
process.env.TZ = "Europe/Berlin";

describe("parseStart", () => {
  it("round-trips what the date and time inputs hold", () => {
    const instant = new Date(2026, 7, 20, 14, 30).getTime();
    expect(parseStart(formatDate(instant), formatTime(instant))).toBe(instant);
  });

  it("reads a date input's value as local time", () => {
    expect(parseStart("2026-08-20", "09:05")).toBe(
      new Date(2026, 7, 20, 9, 5).getTime(),
    );
  });

  it("rejects a date that does not exist", () => {
    expect(parseStart("2026-02-31", "09:00")).toBeUndefined();
    expect(parseStart("2026-13-01", "09:00")).toBeUndefined();
  });

  it("rejects an empty time", () => {
    expect(parseStart("2026-08-20", "")).toBeUndefined();
  });

  it("rejects an empty date", () => {
    expect(parseStart("", "09:00")).toBeUndefined();
  });

  it("resolves a time the clock skips to the instant that follows it", () => {
    // 02:30 does not exist on the spring-forward day, so it means 03:30.
    expect(parseStart("2026-03-29", "02:30")).toBe(
      new Date(2026, 2, 29, 3, 30).getTime(),
    );
  });

  it("reads a time on the day the clock repeats an hour", () => {
    expect(parseStart("2026-10-25", "10:00")).toBe(
      new Date(2026, 9, 25, 10, 0).getTime(),
    );
  });
});

describe("input formatting", () => {
  it("pads a date to what an input expects", () => {
    expect(formatDate(new Date(2026, 0, 5, 9, 0).getTime())).toBe("2026-01-05");
  });

  it("pads a time to what an input expects", () => {
    expect(formatTime(new Date(2026, 0, 5, 9, 5).getTime())).toBe("09:05");
  });
});
