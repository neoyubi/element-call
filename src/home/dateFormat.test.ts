import { describe, expect, it } from "vitest";

import {
  appendDateInput,
  appendTimeInput,
  dateDigitsToIso,
  formatDate,
  formatDateDigits,
  formatTime,
  formatTimeDigits,
  isoToDateDigits,
  parsePastedDate,
  parsePastedTime,
  parseStart,
  timeDigitsToCanonical,
} from "./dateFormat";

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

describe("masked date entry", () => {
  const type = (keys: string): string => appendDateInput("", keys, "dmy");
  const shown = (digits: string): string =>
    formatDateDigits(digits, "dmy", ".");
  const today = new Date(2026, 7, 16);
  const iso = (digits: string): string | undefined =>
    dateDigitsToIso(digits, "dmy", today);

  it("waits on a leading digit that could still be a two-digit day", () => {
    expect(shown(type("2"))).toBe("2");
    expect(shown(type("21"))).toBe("21.");
  });

  it("completes a day that cannot lead a two-digit value", () => {
    expect(shown(type("5"))).toBe("05.");
    expect(shown(type("58"))).toBe("05.08.");
  });

  it("builds the whole date as it is typed", () => {
    expect(shown(type("2108"))).toBe("21.08.");
    expect(shown(type("21082026"))).toBe("21.08.2026");
  });

  it("refuses a second digit that would leave the segment out of range", () => {
    expect(type("32")).toBe("3");
    expect(type("00")).toBe("0");
    expect(type("2119")).toBe("211");
  });

  it("infers the year of a bare day and month", () => {
    expect(iso(type("2108"))).toBe("2026-08-21");
  });

  it("infers next year when the date has already gone by", () => {
    expect(iso(type("0501"))).toBe("2027-01-05");
  });

  it("reads a two-digit year as this century", () => {
    expect(iso(type("210826"))).toBe("2026-08-21");
  });

  it("holds back while the year is half typed", () => {
    expect(iso(type("2108202"))).toBeUndefined();
  });

  it("rejects a date the calendar does not have", () => {
    expect(iso(type("3102"))).toBeUndefined();
  });

  it("lands 29 February on a leap year", () => {
    expect(iso(type("2902"))).toBe("2028-02-29");
  });

  it("round-trips an ISO date", () => {
    expect(isoToDateDigits("2026-08-21", "dmy")).toBe("21082026");
    expect(isoToDateDigits("2026-08-21", "ymd")).toBe("20260821");
  });

  it("reads pasted dates in several shapes", () => {
    expect(parsePastedDate("2026-08-21", "dmy")).toBe("21082026");
    expect(parsePastedDate("21/8/26", "dmy")).toBe("21082026");
    expect(parsePastedDate("21082026", "dmy")).toBe("21082026");
  });
});

describe("masked time entry", () => {
  const type = (keys: string): string => appendTimeInput("", keys);

  it("completes an hour that cannot lead a two-digit value", () => {
    expect(formatTimeDigits(type("9"))).toBe("09:");
    expect(timeDigitsToCanonical(type("9"))).toBe("09:00");
  });

  it("waits on an hour that could still be two digits", () => {
    expect(formatTimeDigits(type("1"))).toBe("1");
    expect(timeDigitsToCanonical(type("14"))).toBe("14:00");
  });

  it("pads a lone minute digit to the right", () => {
    expect(timeDigitsToCanonical(type("930"))).toBe("09:30");
  });

  it("takes a full time unchanged", () => {
    expect(timeDigitsToCanonical(type("1430"))).toBe("14:30");
  });

  it("refuses an hour whose second digit would leave it out of range", () => {
    expect(type("25")).toBe("2");
  });

  it("completes a minute that cannot lead a two-digit value", () => {
    // 6 cannot begin a minute, so it means 06 and the segment is then full.
    expect(timeDigitsToCanonical(type("146"))).toBe("14:06");
    expect(type("1465")).toBe("1406");
  });

  it("reads a pasted twelve-hour time", () => {
    expect(parsePastedTime("2:30 PM")).toBe("1430");
    expect(parsePastedTime("12:15 am")).toBe("0015");
    expect(parsePastedTime("14:30")).toBe("1430");
  });
});
