const SHORT_TEXT_BYPASS_MAX_CHARS = 6;

function shouldSkipPolish(text, maxChars = SHORT_TEXT_BYPASS_MAX_CHARS) {
  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (!trimmedText || !Number.isFinite(maxChars) || maxChars <= 0) return false;
  return [...trimmedText].length <= maxChars;
}

module.exports = {
  SHORT_TEXT_BYPASS_MAX_CHARS,
  shouldSkipPolish,
};
