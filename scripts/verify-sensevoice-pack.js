const path = require('path');
const {
  SENSEVOICE_MODEL_MANIFEST,
  verifyModelDirectory,
} = require('./sensevoice-model');

function resolveMacModelDir(context) {
  const productFilename = context.packager?.appInfo?.productFilename;
  if (!productFilename) {
    throw new Error('无法确定 macOS 应用包名称，不能校验 SenseVoice 模型');
  }
  return path.join(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'models',
    'sensevoice',
  );
}

function resolveWindowsModelDir(context) {
  return path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'models', 'sensevoice');
}

async function verifySenseVoicePack(context) {
  // 两平台统一验证同一固定模型快照；Linux 尚未声明内置 SenseVoice。
  if (!['darwin', 'win32'].includes(context.electronPlatformName)) return;

  const modelDir = context.electronPlatformName === 'darwin'
    ? resolveMacModelDir(context)
    : resolveWindowsModelDir(context);
  const result = await verifyModelDirectory(modelDir);
  if (!result.ok) {
    const details = result.invalid.map(({ name, reason }) => `${name}(${reason})`).join(', ');
    throw new Error(`打包产物缺少或损坏 SenseVoice ${SENSEVOICE_MODEL_MANIFEST.revision} 模型: ${details}`);
  }
  console.log(`[SenseVoice] 打包产物校验通过: ${modelDir}`);
}

module.exports = verifySenseVoicePack;
module.exports.resolveMacModelDir = resolveMacModelDir;
module.exports.resolveWindowsModelDir = resolveWindowsModelDir;
