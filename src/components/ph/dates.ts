const asDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);

export function dateBlock(d: Date | string) {
  const date = asDate(d);
  return {
    month: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(),
    dayYear: `${date.getUTCDate()}, ${date.getUTCFullYear()}`,
    iso: date.toISOString(),
  };
}

export function longDate(d: Date | string) {
  const date = asDate(d);
  return {
    label: date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }),
    iso: date.toISOString(),
  };
}
