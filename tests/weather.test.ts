import { describe, expect, it } from "vitest";
import {
  condition,
  forecastUrl,
  formatForecast,
  getForecast,
  localDate,
  summarise,
} from "../lib/weather";
import { fakeFetch, openMeteo } from "./fixtures";

const DATE = "2026-10-31";

describe("summarise", () => {
  it("reduces the hourly series to the three day-strip slots", () => {
    expect(summarise(openMeteo(), DATE)).toEqual({
      place: "Porto",
      date: DATE,
      min: 9,
      max: 16,
      condition: "partly cloudy",
      slots: [
        { label: "08:00–12:00", temp: 15, condition: "clear", rain: 0 },
        { label: "12:00–18:00", temp: 18, condition: "partly cloudy", rain: 0 },
        { label: "18:00 →", temp: 21, condition: "light showers", rain: 40 },
      ],
    });
  });

  it("ignores hours from other dates", () => {
    const json = openMeteo();
    json.hourly!.time = json.hourly!.time.map((t) => t.replace(DATE, "2026-10-30"));
    json.daily!.time = [DATE];
    const day = summarise(json, DATE);
    expect(day.slots.every((s) => s.temp === null && s.rain === null && s.condition === "unknown")).toBe(true);
  });

  it("refuses a response without that date", () => {
    expect(() => summarise(openMeteo("2026-11-01"), DATE)).toThrow("no forecast for 2026-10-31");
  });
});

describe("condition", () => {
  it("names WMO codes and passes unknown ones through", () => {
    expect(condition(0)).toBe("clear");
    expect(condition(63)).toBe("rain");
    expect(condition(42)).toBe("code 42");
    expect(condition(null)).toBe("unknown");
  });
});

describe("localDate", () => {
  it("uses Lisbon's date, not UTC's", () => {
    // 23:30 UTC on 30 Jun is 00:30 on 1 Jul in Lisbon (summer time, UTC+1).
    expect(localDate(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
    expect(localDate(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
  });
});

describe("getForecast", () => {
  it("asks Open-Meteo for one local day in Porto", async () => {
    const { fetch, calls } = fakeFetch({ [forecastUrl(DATE)]: JSON.stringify(openMeteo()) });
    const day = await getForecast(DATE, { fetch });
    expect(day.max).toBe(16);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("timezone")).toBe("Europe/Lisbon");
    expect(url.searchParams.get("start_date")).toBe(DATE);
    expect(url.searchParams.get("end_date")).toBe(DATE);
  });

  it("reports Open-Meteo's reason for a refused request", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: true, reason: "Parameter 'start_date' is out of allowed range" }), {
        status: 400,
      })) as typeof globalThis.fetch;
    await expect(getForecast("2027-12-01", { fetch })).rejects.toThrow(
      "Open-Meteo HTTP 400: Parameter 'start_date' is out of allowed range",
    );
  });

  it("reports a bare HTTP error", async () => {
    const { fetch } = fakeFetch({ [forecastUrl(DATE)]: 503 });
    await expect(getForecast(DATE, { fetch })).rejects.toThrow("Open-Meteo HTTP 503");
  });
});

describe("formatForecast", () => {
  it("prints the day, then one line per slot", () => {
    expect(formatForecast(summarise(openMeteo(), DATE)).split("\n")).toEqual([
      "Porto · 2026-10-31 · 9–16°C, partly cloudy (Open-Meteo)",
      "08:00–12:00 · 15°C, clear, rain 0%",
      "12:00–18:00 · 18°C, partly cloudy, rain 0%",
      "18:00 → · 21°C, light showers, rain 40%",
    ]);
  });
});
