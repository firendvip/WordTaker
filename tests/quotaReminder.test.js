import { afterAll, beforeAll, describe, expect, it } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CatSkin from "../src/components/CatSkin.jsx";
import CatSkinFx from "../src/components/CatSkinFx.jsx";
import {
  QUOTA_REMINDER_INTERVAL_MS,
  nextQuotaReminderTimestamp,
  readQuotaReminderTimestamp,
  shouldShowQuotaExhaustedReminder,
  writeQuotaReminderTimestamp,
} from "../src/utils/quotaReminder.js";

const NOW = Date.UTC(2026, 6, 26, 8, 0, 0);

describe("quota exhausted reminder", () => {
  beforeAll(() => {
    globalThis.React = React;
  });

  afterAll(() => {
    delete globalThis.React;
  });

  it("shows the first reminder only for an explicit exhausted quota", () => {
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: null,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: -20,
        lastShownAt: null,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("suppresses unknown, loading, failed and recovered quota states", () => {
    for (const cloudRemaining of [null, undefined, Number.NaN, "0"]) {
      expect(
        shouldShowQuotaExhaustedReminder({
          cloudRemaining,
          lastShownAt: null,
          now: NOW,
        }),
      ).toBe(false);
    }

    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: null,
        now: NOW,
        loading: true,
      }),
    ).toBe(false);
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: null,
        now: NOW,
        requestFailed: true,
      }),
    ).toBe(false);
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 1,
        lastShownAt: null,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("enforces a rolling seven-day window with an inclusive boundary", () => {
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: NOW - QUOTA_REMINDER_INTERVAL_MS + 1,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: NOW - QUOTA_REMINDER_INTERVAL_MS,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("does not bypass throttling when the system clock moves backwards", () => {
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: NOW + 60_000,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("records only a shown or dismissed reminder", () => {
    expect(
      nextQuotaReminderTimestamp({
        previousTimestamp: 123,
        event: "eligible",
        now: NOW,
      }),
    ).toBe(123);
    expect(
      nextQuotaReminderTimestamp({
        previousTimestamp: null,
        event: "shown",
        now: NOW,
      }),
    ).toBe(NOW);
    expect(
      nextQuotaReminderTimestamp({
        previousTimestamp: 123,
        event: "dismissed",
        now: NOW,
      }),
    ).toBe(NOW);
  });

  it("persists the successful presentation timestamp across app restarts", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };

    expect(writeQuotaReminderTimestamp(storage, "eligible", NOW)).toBe(null);
    expect(writeQuotaReminderTimestamp(storage, "shown", NOW)).toBe(NOW);
    const restoredTimestamp = readQuotaReminderTimestamp(storage);
    expect(restoredTimestamp).toBe(NOW);
    expect(
      shouldShowQuotaExhaustedReminder({
        cloudRemaining: 0,
        lastShownAt: restoredTimestamp,
        now: NOW + 1000,
      }),
    ).toBe(false);
  });

  it("renders the accessible reminder in both cat skin paths", () => {
    for (const Component of [CatSkin, CatSkinFx]) {
      const markup = renderToStaticMarkup(
        createElement(Component, {
          micState: "recording",
          showQuotaExhaustedBubble: true,
        }),
      );
      expect(markup).toContain('role="status"');
      expect(markup).toContain("云端字数已用尽");
      expect(markup).toContain('aria-label="关闭云端字数提醒"');
    }
  });
});
