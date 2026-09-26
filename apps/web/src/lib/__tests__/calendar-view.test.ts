import { describe, expect, it } from "vitest";
import { calendarDays, clockTime, localDate, shiftDate, validDate } from "../calendar-view";

describe("clinic calendar dates", () => {
  it("uses the clinic's date even when the browser's day is different", () => {
    expect(localDate("2027-01-01T02:00:00Z", "America/New_York")).toBe("2026-12-31");
    expect(localDate("2027-01-01T02:00:00Z", "Asia/Kolkata")).toBe("2027-01-01");
  });
  it("keeps a week at seven calendar days across daylight saving", () => {
    expect(calendarDays("2027-03-14", "week")).toEqual(["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13", "2027-03-14"]);
    expect(shiftDate("2027-03-14", 1)).toBe("2027-03-15");
  });
  it("handles year and leap-day boundaries", () => {
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(calendarDays("2027-01-01", "day")).toEqual(["2027-01-01"]);
  });
  it("falls back for malformed and impossible date parameters", () => {
    for (const value of [undefined, "nonsense", "2027-02-30", "2027-13-01"]) {
      expect(validDate(value, "2027-03-01")).toBe("2027-03-01");
    }
    expect(validDate("2028-02-29", "2027-03-01")).toBe("2028-02-29");
  });
  it("shows winter and summer bookings in the clinic's wall-clock time", () => {
    expect(clockTime("2027-01-15T14:00:00Z", "America/New_York")).toBe("9:00 AM");
    expect(clockTime("2027-07-15T13:00:00Z", "America/New_York")).toBe("9:00 AM");
  });
});
