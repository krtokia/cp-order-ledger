export function getTargetDateRange(now = new Date()) {
  const startDate = subtractOneMonth(now);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(now);
  return { startDate, endDate };
}

export function subtractOneMonth(date) {
  const result = new Date(date);
  const originalDay = result.getDate();

  result.setDate(1);
  result.setMonth(result.getMonth() - 1);

  const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDayOfTargetMonth));

  return result;
}

export function subtractDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
}

export function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

export function parseLocalDateInput(value) {
  if (!value) return null;

  const match = String(value).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return makeValidDate(year, month, day);
}

export function parseFlexibleDate(text) {
  if (!text) return null;

  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const patterns = [
    /(?<year>\d{4})\s*\.\s*(?<month>\d{1,2})\s*\.\s*(?<day>\d{1,2})/,
    /(?<year>\d{4})\s*년\s*(?<month>\d{1,2})\s*월\s*(?<day>\d{1,2})\s*일?/,
    /(?<year>\d{4})\s*[-/]\s*(?<month>\d{1,2})\s*[-/]\s*(?<day>\d{1,2})/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.groups) continue;

    const date = makeValidDate(
      Number(match.groups.year),
      Number(match.groups.month),
      Number(match.groups.day)
    );

    if (date) return date;
  }

  return null;
}

export function formatLocalDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function makeValidDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}
