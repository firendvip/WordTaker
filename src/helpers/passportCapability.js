function explicitTrue(value) {
  return value === 1 || (typeof value === "string" && /^(1|true)$/i.test(value));
}

function explicitFalse(value) {
  return value === 0 || (typeof value === "string" && /^(0|false)$/i.test(value));
}

function resolvePassportCapability({
  isPackaged = false,
  packageMetadata = {},
  environmentValue,
} = {}) {
  const candidateBuild = packageMetadata?.wordtakerPassportCandidate === true;
  const enabled = isPackaged
    ? candidateBuild && !explicitFalse(environmentValue)
    : explicitTrue(environmentValue);
  return Object.freeze({ candidateBuild, enabled });
}

function createPassportPreloadApi({ enabled = false, ipcRenderer } = {}) {
  if (!enabled) return Object.freeze({});
  if (!ipcRenderer || typeof ipcRenderer.invoke !== "function") {
    throw new TypeError("Passport preload requires ipcRenderer");
  }
  return Object.freeze({
    authPassportLogin: () => ipcRenderer.invoke("auth-passport-login"),
    authPassportAccount: () => ipcRenderer.invoke("auth-passport-account"),
    onPassportAuthResult: (callback) => {
      const listener = (_event, result) => callback(result);
      ipcRenderer.on("passport-auth-result", listener);
      return () => ipcRenderer.removeListener("passport-auth-result", listener);
    },
  });
}

module.exports = {
  createPassportPreloadApi,
  resolvePassportCapability,
};
