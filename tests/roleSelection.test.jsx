// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
vi.mock("../src/hooks/usePermissions", () => ({ usePermissions: () => ({}) }));
vi.mock("../src/components/account/AccountPanel", () => ({ AccountPanel: () => null }));
vi.mock("../src/components/ui/permission-card", () => ({ default: () => null }));

describe("desktop role selector", () => {
  let root, container, api;
  const roleButtons = () => [...container.querySelectorAll("button")].filter((button) => button.querySelector("label"));
  const selected = (button) => button.querySelector('[aria-hidden="true"] > span') !== null;
  const render = async (role) => {
    api.getAllSettings.mockResolvedValue({ llm_active_role: role });
    await act(async () => root.render(<SettingsPage />));
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", "/settings.html?tab=role");
    api = { getAllSettings: vi.fn(), setSetting: vi.fn().mockResolvedValue({ success: true }) };
    window.electronAPI = api;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.electronAPI;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it("offers exactly the unchanged normal and VibeCoding choices", async () => {
    await render("normal");
    expect(roleButtons().map((button) => button.querySelector("label").textContent)).toEqual(["常规", "VibeCoding专用"]);
    expect(container.textContent).not.toContain("高情商");
    expect(roleButtons()[0].textContent).toContain("像正常人自然表达，理顺逻辑、去重复啰嗦，让话更顺更清楚");
    expect(roleButtons()[1].textContent).toContain("将你的话改写成让AI更能看懂的语言");
  });

  it("shows normal selected for a legacy hidden setting", async () => {
    await render("gaoeq");
    expect(selected(roleButtons()[0])).toBe(true);
    expect(selected(roleButtons()[1])).toBe(false);
  });

  it("keeps VibeCoding selected and persists either available choice unchanged", async () => {
    await render("vibecoding");
    expect(selected(roleButtons()[1])).toBe(true);
    await act(async () => roleButtons()[0].click());
    expect(api.setSetting).toHaveBeenLastCalledWith("llm_active_role", "normal");
    expect(selected(roleButtons()[0])).toBe(true);
    await act(async () => roleButtons()[1].click());
    expect(api.setSetting).toHaveBeenLastCalledWith("llm_active_role", "vibecoding");
    expect(selected(roleButtons()[1])).toBe(true);
  });
});
