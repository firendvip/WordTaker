const path = require('path');
const {
  SENSEVOICE_MODEL_MANIFEST,
  verifyModelDirectory,
} = require('./sensevoice-model');

async function verifySenseVoicePack(context) {
  // 本轮只建立 macOS 的模型准备/打包闭环。Windows 继续由既有 CI 下载与
  // Assert SenseVoice model packed 步骤负责；Linux 尚未声明内置 SenseVoice。
  if (context.electronPlatformName !== 'darwin') return;

  const modelDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'models',
    'sensevoice',
  );
  const result = await verifyModelDirectory(modelDir);
  if (!result.ok) {
    const details = result.invalid.map(({ name, reason }) => `${name}(${reason})`).join(', ');
    throw new Error(`打包产物缺少或损坏 SenseVoice ${SENSEVOICE_MODEL_MANIFEST.revision} 模型: ${details}`);
  }
  console.log(`[SenseVoice] 打包产物校验通过: ${modelDir}`);
}

module.exports = verifySenseVoicePack;
