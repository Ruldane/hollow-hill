/**
 * The world outside the glass: the visitor's real clock, a guessed place,
 * the sun, the moon, the season and the weather.
 *
 * Weather is deterministic per colony and per local calendar day, so the
 * absence model can ask "did it rain on Tuesday afternoon?" and get the
 * same answer the live simulation would have seen.
 */
import { hash01 } from "./rng";

export interface Place {
  timeZone: string;
  /** +1 northern, -1 southern. */
  hemisphere: 1 | -1;
  /** Degrees; a coarse guess from the time zone. */
  latitude: number;
  /** Minutes east of UTC at the moment the colony was loaded. */
  offsetMinutes: number;
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export interface EnvSample {
  now: number;
  localHour: number;
  dayOfYear: number;
  /** Local calendar day number since the Unix epoch. */
  dayNumber: number;
  season: Season;
  /** -1 (deep winter) .. +1 (high summer). */
  warmth: number;
  sunAltitude: number;
  /** 0 night .. 1 full day, smoothed through twilight. */
  daylight: number;
  moonPhase: number;
  surfaceTemp: number;
  deepTemp: number;
  rain: number;
  /** Barometric pressure in hPa; falls ahead of showers. */
  pressure: number;
  lampLit: boolean;
  /** How willing foragers are to go abroad, 0..1. */
  activity: number;
  flightWeather: boolean;
  /** Seeds falling from the grass heads per hour. */
  seedRate: number;
}

const SOUTHERN_PREFIXES = [
  "Australia/",
  "Antarctica/",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "Pacific/Fiji",
  "Pacific/Noumea",
  "Pacific/Tongatapu",
  "America/Argentina",
  "America/Buenos_Aires",
  "America/Santiago",
  "America/Sao_Paulo",
  "America/Montevideo",
  "America/Asuncion",
  "America/Punta_Arenas",
  "Africa/Johannesburg",
  "Africa/Maputo",
  "Africa/Windhoek",
  "Africa/Harare",
  "Africa/Lusaka",
  "Indian/Mauritius",
  "Indian/Reunion",
  "Atlantic/Stanley",
];

const TROPICAL_PREFIXES = [
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Kuala_Lumpur",
  "Asia/Manila",
  "Asia/Bangkok",
  "Asia/Ho_Chi_Minh",
  "America/Bogota",
  "America/Caracas",
  "America/Lima",
  "America/Guayaquil",
  "America/Panama",
  "America/Costa_Rica",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Accra",
  "Africa/Kinshasa",
  "Pacific/Honolulu",
];

export function placeFromTimeZone(timeZone: string, offsetMinutes: number): Place {
  const tz = timeZone || "Europe/London";
  if (TROPICAL_PREFIXES.some((p) => tz.startsWith(p))) {
    const south = tz.startsWith("America/Lima") || tz.startsWith("Asia/Jakarta");
    return { timeZone: tz, hemisphere: south ? -1 : 1, latitude: south ? -8 : 8, offsetMinutes };
  }
  if (SOUTHERN_PREFIXES.some((p) => tz.startsWith(p))) {
    return { timeZone: tz, hemisphere: -1, latitude: -35, offsetMinutes };
  }
  let latitude = 48;
  if (tz.startsWith("America/")) latitude = 40;
  else if (tz.startsWith("Asia/")) latitude = 34;
  else if (tz.startsWith("Africa/")) latitude = 30;
  else if (tz.startsWith("Europe/")) latitude = 50;
  if (/Stockholm|Oslo|Helsinki|Reykjavik|Anchorage|Tallinn|Riga/.test(tz)) latitude = 60;
  return { timeZone: tz, hemisphere: 1, latitude, offsetMinutes };
}

const DAY_MS = 86_400_000;
const RAD = Math.PI / 180;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function localTime(now: number, place: Place) {
  const local = now + place.offsetMinutes * 60_000;
  const d = new Date(local);
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((local - startOfYear) / DAY_MS);
  const localHour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const dayNumber = Math.floor(local / DAY_MS);
  return { dayOfYear, localHour, dayNumber, month: d.getUTCMonth(), date: d.getUTCDate(), year: d.getUTCFullYear() };
}

export function sunAltitude(dayOfYear: number, localHour: number, latitude: number): number {
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
  const hourAngle = 15 * (localHour - 12);
  const s =
    Math.sin(latitude * RAD) * Math.sin(decl * RAD) +
    Math.cos(latitude * RAD) * Math.cos(decl * RAD) * Math.cos(hourAngle * RAD);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

export function moonPhase(now: number): number {
  const knownNew = Date.UTC(2000, 0, 6, 18, 14);
  const synodic = 29.530588853;
  const days = (now - knownNew) / DAY_MS;
  return (((days % synodic) + synodic) % synodic) / synodic;
}

/** -1 at the depth of winter, +1 at the height of summer. */
export function seasonalWarmth(dayOfYear: number, hemisphere: 1 | -1): number {
  const w = -Math.cos(((2 * Math.PI) / 365) * (dayOfYear - 22));
  return w * hemisphere;
}

export function seasonOf(dayOfYear: number, hemisphere: 1 | -1): Season {
  // Meteorological seasons, shifted by half a year in the south.
  const shifted = hemisphere === 1 ? dayOfYear : (dayOfYear + 182) % 365;
  if (shifted >= 59 && shifted < 151) return "spring";
  if (shifted >= 151 && shifted < 243) return "summer";
  if (shifted >= 243 && shifted < 334) return "autumn";
  return "winter";
}

export interface Shower {
  start: number; // local hour
  end: number;
  intensity: number;
}

const RAIN_CHANCE: Record<Season, number> = { spring: 0.36, summer: 0.24, autumn: 0.4, winter: 0.3 };

/** The showers of one local day, deterministic for a colony. */
export function showersOn(dayNumber: number, dayOfYear: number, place: Place, weatherSeed: number): Shower[] {
  const season = seasonOf(dayOfYear, place.hemisphere);
  if (hash01(weatherSeed, dayNumber, 1) >= RAIN_CHANCE[season]) return [];
  const count = hash01(weatherSeed, dayNumber, 2) < 0.4 ? 2 : 1;
  const showers: Shower[] = [];
  for (let i = 0; i < count; i++) {
    const start = 1 + hash01(weatherSeed, dayNumber, 10 + i) * 21;
    const length = 0.35 + hash01(weatherSeed, dayNumber, 20 + i) * 1.6;
    const intensity = 0.35 + hash01(weatherSeed, dayNumber, 30 + i) * 0.65;
    showers.push({ start, end: Math.min(24, start + length), intensity });
  }
  return showers;
}

export type WeatherOverride = "rain" | "dry" | null;

function rainAt(localHour: number, showers: Shower[]): number {
  let r = 0;
  for (const s of showers) {
    const ramp = 0.12;
    const v = Math.min(smoothstep(s.start, s.start + ramp, localHour), 1 - smoothstep(s.end - ramp, s.end, localHour));
    r = Math.max(r, v * s.intensity);
  }
  return r;
}

export function sampleEnv(now: number, place: Place, weatherSeed: number, override: WeatherOverride = null): EnvSample {
  const { dayOfYear, localHour, dayNumber } = localTime(now, place);
  const season = seasonOf(dayOfYear, place.hemisphere);
  const warmth = seasonalWarmth(dayOfYear, place.hemisphere);
  const alt = sunAltitude(dayOfYear, localHour, place.latitude);
  const daylight = smoothstep(-8, 8, alt);

  const showers = showersOn(dayNumber, dayOfYear, place, weatherSeed);
  let rain = rainAt(localHour, showers);
  if (override === "rain") rain = 0.85;
  if (override === "dry") rain = 0;

  // Pressure drops ahead of and during a shower.
  let dip = 0;
  for (const s of showers) {
    const lead = s.start - localHour;
    if (localHour <= s.end && lead < 6) dip = Math.max(dip, s.intensity * (lead > 0 ? 1 - lead / 6 : 1));
  }
  if (override === "rain") dip = 0.9;
  if (override === "dry") dip = 0;
  const pressure = 1017 + (hash01(weatherSeed, dayNumber, 99) - 0.5) * 8 - dip * 16;

  const absLat = Math.abs(place.latitude);
  const mean = 27 - 0.35 * absLat;
  const seasonal = 0.26 * absLat * warmth;
  const diurnal = 5.5 * Math.cos(((2 * Math.PI) / 24) * (localHour - 15));
  const surfaceTemp = mean + seasonal + diurnal * (0.4 + 0.6 * daylight) - rain * 4;
  const deepTemp = mean + seasonal * 0.45;

  const cold = smoothstep(4, 14, surfaceTemp);
  const activity = Math.max(0.06, daylight * cold * (1 - rain * 0.85));

  const shifted = place.hemisphere === 1 ? dayOfYear : (dayOfYear + 182) % 365;
  const inFlightSeason = shifted >= 161 && shifted <= 273;
  const flightWeather = inFlightSeason && localHour >= 16.5 && localHour <= 21 && rain < 0.05 && surfaceTemp > 14;

  // Grass seeds ripen through late summer and autumn.
  const seedSeason = Math.max(0, Math.sin(((shifted - 150) / 200) * Math.PI));
  const seedRate = season === "winter" ? 4 : 10 + 50 * seedSeason;

  return {
    now,
    localHour,
    dayOfYear,
    dayNumber,
    season,
    warmth,
    sunAltitude: alt,
    daylight,
    moonPhase: moonPhase(now),
    surfaceTemp,
    deepTemp,
    rain,
    pressure,
    lampLit: alt < 3,
    activity,
    flightWeather,
    seedRate,
  };
}

/** Temperature at a world row, including the laboratory lamp that warms the nursery glass. */
export function temperatureAt(row: number, groundRow: number, env: EnvSample, nurseryRow: number): number {
  if (row < groundRow) return env.surfaceTemp;
  const depth = row - groundRow;
  const k = Math.exp(-depth / 110);
  let t = env.deepTemp + (env.surfaceTemp - env.deepTemp) * k;
  const lamp = env.lampLit ? 7 : 3.5;
  const d = (row - nurseryRow) / 70;
  t += lamp * Math.exp(-d * d);
  return t;
}
