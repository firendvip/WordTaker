const PRODUCT_NAME = "弦外小猫";

export function formatRuntimeAppTitle(version) {
  const normalizedVersion =
    typeof version === "string" ? version.trim() : "";
  return normalizedVersion
    ? `${PRODUCT_NAME} ${normalizedVersion}`
    : PRODUCT_NAME;
}

export async function syncRuntimeDocumentTitle({
  getAppVersion,
  documentRef = globalThis.document,
} = {}) {
  if (!documentRef) return;
  try {
    const version =
      typeof getAppVersion === "function" ? await getAppVersion() : "";
    documentRef.title = formatRuntimeAppTitle(version);
  } catch {
    documentRef.title = PRODUCT_NAME;
  }
}
