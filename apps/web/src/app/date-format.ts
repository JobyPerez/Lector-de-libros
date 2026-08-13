const relativeTimeFormatter = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

const RELATIVE_TIME_UNITS: Array<{
  limit: number;
  milliseconds: number;
  unit: Intl.RelativeTimeFormatUnit;
}> = [
  { limit: 60, milliseconds: 1_000, unit: "second" },
  { limit: 60, milliseconds: 60_000, unit: "minute" },
  { limit: 24, milliseconds: 3_600_000, unit: "hour" },
  { limit: 30, milliseconds: 86_400_000, unit: "day" },
  { limit: 12, milliseconds: 2_592_000_000, unit: "month" },
  { limit: Number.POSITIVE_INFINITY, milliseconds: 31_536_000_000, unit: "year" }
];

export function formatRelativeDate(value: string | Date, now = new Date()): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const elapsedMilliseconds = Math.max(0, now.getTime() - date.getTime());
  for (const { limit, milliseconds, unit } of RELATIVE_TIME_UNITS) {
    const elapsedUnits = elapsedMilliseconds / milliseconds;
    if (elapsedUnits < limit) {
      return relativeTimeFormatter.format(-Math.round(elapsedUnits), unit);
    }
  }

  return null;
}

export function formatExactDate(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString("es-ES", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}
