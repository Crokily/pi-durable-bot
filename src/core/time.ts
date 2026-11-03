/** One formatter for every time the agent reads: making one takes far longer than formatting with it. */
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "long",
  hourCycle: "h23",
  timeZoneName: "short",
});

/** "2026-10-27 17:04:07 Tuesday (GMT+11)", in the machine's time zone. */
export function formatTime(ms: number): string {
  const parts = Object.fromEntries(TIME_FORMAT.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.weekday} (${parts.timeZoneName})`;
}
