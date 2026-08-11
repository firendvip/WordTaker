export const QUOTA_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const QUOTA_REMINDER_STORAGE_KEY = "quota_exhausted_reminder_last_shown_at";

function finiteTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function shouldShowQuotaExhaustedReminder({
  cloudRemaining,
  lastShownAt,
  now = Date.now(),
  loading = false,
  requestFailed = false,
} = {}) {
  if (loading || requestFailed) return false;
  if (
    typeof cloudRemaining !== "number" ||
    !Number.isFinite(cloudRemaining) ||
    cloudRemaining > 0
  ) {
    return false;
  }

  const currentTime = finiteTimestamp(now);
  if (currentTime === null) return false;

  const previousTime = finiteTimestamp(lastShownAt);
  if (previousTime === null) return true;
  if (currentTime < previousTime) return false;
  return currentTime - previousTime >= QUOTA_REMINDER_INTERVAL_MS;
}

export function nextQuotaReminderTimestamp({
  previousTimestamp = null,
  event,
  now = Date.now(),
} = {}) {
  if (event !== "shown" && event !== "dismissed") return previousTimestamp;
  const timestamp = finiteTimestamp(now);
  return timestamp === null ? previousTimestamp : timestamp;
}

export function readQuotaReminderTimestamp(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    return finiteTimestamp(storage.getItem(QUOTA_REMINDER_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeQuotaReminderTimestamp(storage, event, now = Date.now()) {
  if (!storage || typeof storage.setItem !== "function") return null;
  const previousTimestamp = readQuotaReminderTimestamp(storage);
  const nextTimestamp = nextQuotaReminderTimestamp({
    previousTimestamp,
    event,
    now,
  });
  if (nextTimestamp === previousTimestamp) return previousTimestamp;
  try {
    storage.setItem(QUOTA_REMINDER_STORAGE_KEY, String(nextTimestamp));
    return nextTimestamp;
  } catch {
    return previousTimestamp;
  }
}
