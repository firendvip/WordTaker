const VALID_PILL_SKINS = new Set(["music", "voiceink", "catfx", "cat"]);

export function isResolvedPillSkin(value) {
  return VALID_PILL_SKINS.has(value);
}

export function normalizePillSkin(value) {
  return isResolvedPillSkin(value) ? value : "music";
}
