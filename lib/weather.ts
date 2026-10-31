import type { Deps } from "./youtube";

/** The one place the Daily brief needs weather for. */
export const PORTO = { name: "Porto", latitude: 41.1496, longitude: -8.611, timezone: "Europe/Lisbon" } as const;

export type Place = typeof PORTO;

/** The brief's day strip: label, first hour, end hour (exclusive), hour whose temperature represents it. */
export const SLOTS = [
  { label: "08:00–12:00", from: 8, to: 12, mid: 10 },
  { label: "12:00–18:00", from: 12, to: 18, mid: 15 },
  { label: "18:00 →", from: 18, to: 24, mid: 21 },
] as const;

/** WMO weather interpretation codes, as Open-Meteo documents them. */
const CONDITIONS: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "heavy showers",
  85: "snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with hail",
};

export function condition(code: number | null | undefined): string {
  return code == null ? "unknown" : (CONDITIONS[code] ?? `code ${code}`);
}

/** The subset of Open-Meteo's /v1/forecast response this module asks for. */
export type OpenMeteo = {
  hourly?: {
    time: string[];
    temperature_2m: (number | null)[];
    precipitation_probability: (number | null)[];
    weather_code: (number | null)[];
  };
  daily?: {
    time: string[];
    weather_code: (number | null)[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
  };
};

export type SlotForecast = { label: string; temp: number | null; condition: string; rain: number | null };

export type DayForecast = {
  place: string;
  date: string;
  min: number | null;
  max: number | null;
  condition: string;
  slots: SlotForecast[];
};

export function forecastUrl(date: string, place: Place = PORTO): string {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: place.timezone,
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    start_date: date,
    end_date: date,
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/** Today's date (YYYY-MM-DD) in the place's own timezone. */
export function localDate(now: Date, timezone: string = PORTO.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const round = (n: number | null | undefined) => (n == null ? null : Math.round(n));

/** Reduces Open-Meteo's hourly series for one local date to the three day-strip slots. */
export function summarise(json: OpenMeteo, date: string, place: Place = PORTO): DayForecast {
  const hourly = json.hourly;
  const dayIndex = json.daily?.time.indexOf(date) ?? -1;
  if (!hourly || dayIndex < 0) throw new Error(`no forecast for ${date}`);

  // Open-Meteo returns local times ("2026-10-31T15:00") when a timezone is requested.
  const at = new Map<number, number>();
  hourly.time.forEach((t, i) => {
    if (t.startsWith(date)) at.set(Number(t.slice(11, 13)), i);
  });

  const slots = SLOTS.map((s) => {
    const mid = at.get(s.mid);
    const rains: number[] = [];
    for (let h = s.from; h < s.to; h++) {
      const i = at.get(h);
      const p = i === undefined ? null : hourly.precipitation_probability[i];
      if (p != null) rains.push(p);
    }
    return {
      label: s.label,
      temp: mid === undefined ? null : round(hourly.temperature_2m[mid]),
      condition: mid === undefined ? "unknown" : condition(hourly.weather_code[mid]),
      rain: rains.length ? Math.max(...rains) : null,
    };
  });

  return {
    place: place.name,
    date,
    min: round(json.daily!.temperature_2m_min[dayIndex]),
    max: round(json.daily!.temperature_2m_max[dayIndex]),
    condition: condition(json.daily!.weather_code[dayIndex]),
    slots,
  };
}

export async function getForecast(date: string, deps: Deps, place: Place = PORTO): Promise<DayForecast> {
  const res = await deps.fetch(forecastUrl(date, place), {
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!res.ok) {
    // Open-Meteo explains bad requests (e.g. a date outside its range) in {"reason": "…"}.
    const reason = await res
      .json()
      .then((b: { reason?: string }) => b.reason)
      .catch(() => undefined);
    throw new Error(`Open-Meteo HTTP ${res.status}${reason ? `: ${reason}` : ""}`);
  }
  return summarise((await res.json()) as OpenMeteo, date, place);
}

const deg = (n: number | null) => (n == null ? "?" : `${n}°C`);

export function formatForecast(f: DayForecast): string {
  return [
    `${f.place} · ${f.date} · ${f.min ?? "?"}–${deg(f.max)}, ${f.condition} (Open-Meteo)`,
    ...f.slots.map((s) => `${s.label} · ${deg(s.temp)}, ${s.condition}, rain ${s.rain == null ? "?" : `${s.rain}%`}`),
  ].join("\n");
}
