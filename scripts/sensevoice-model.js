const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_MODEL_DIR = path.join(PROJECT_ROOT, 'models', 'sensevoice');
const MODELSCOPE_RESOLVE_BASE = 'https://www.modelscope.cn/models';

// Official pre-exported INT8 ONNX snapshot. The tag, byte sizes and SHA-256
// values are all pinned so a moved tag or truncated cache fails the build.
const SENSEVOICE_MODEL_MANIFEST = Object.freeze({
  modelId: 'iic/SenseVoiceSmall-onnx',
  revision: 'v2.0.5',
  files: Object.freeze([
    Object.freeze({
      name: 'model_quant.onnx',
      size: 241216270,
      sha256: '21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822',
    }),
    Object.freeze({
      name: 'tokens.json',
      size: 352064,
      sha256: 'a2594fc1474e78973149cba8cd1f603ebed8c39c7decb470631f66e70ce58e97',
    }),
    Object.freeze({
      name: 'config.yaml',
      size: 1855,
      sha256: 'f71e239ba36705564b5bf2d2ffd07eece07b8e3f2bbf6d2c99d8df856339ac19',
    }),
    Object.freeze({
      name: 'am.mvn',
      size: 11203,
      sha256: '29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5',
    }),
  ]),
});

function fileUrl(manifest, fileName) {
  return `${MODELSCOPE_RESOLVE_BASE}/${manifest.modelId}/resolve/${manifest.revision}/${encodeURIComponent(fileName)}`;
}

function safeUrlForError(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyModelDirectory(modelDir, manifest = SENSEVOICE_MODEL_MANIFEST) {
  const invalid = [];

  for (const file of manifest.files) {
    const filePath = path.join(modelDir, file.name);
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        invalid.push({ name: file.name, reason: 'missing' });
        continue;
      }
      throw error;
    }

    if (!stat.isFile()) {
      invalid.push({ name: file.name, reason: 'not-a-file' });
      continue;
    }
    if (stat.size !== file.size) {
      invalid.push({
        name: file.name,
        reason: 'size-mismatch',
        expected: file.size,
        actual: stat.size,
      });
      continue;
    }

    const actualSha256 = await sha256File(filePath);
    if (actualSha256 !== file.sha256) {
      invalid.push({
        name: file.name,
        reason: 'sha256-mismatch',
        expected: file.sha256,
        actual: actualSha256,
      });
    }
  }

  return {
    ok: invalid.length === 0,
    modelDir,
    modelId: manifest.modelId || null,
    revision: manifest.revision || null,
    invalid,
  };
}

function downloadToFile(
  url,
  outputPath,
  { onProgress, redirectsLeft = 5, expectedSize = null, httpGet = https.get } = {},
) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'WordTaker-build/1.0',
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirectsLeft <= 0) {
          reject(new Error(`模型下载重定向失败: ${safeUrlForError(url)}`));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url);
        if (redirectUrl.protocol !== 'https:') {
          reject(new Error(`拒绝非 HTTPS 模型下载地址: ${redirectUrl}`));
          return;
        }
        downloadToFile(redirectUrl.toString(), outputPath, {
          onProgress,
          redirectsLeft: redirectsLeft - 1,
          expectedSize,
          httpGet,
        }).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(
          `模型下载失败 (HTTP ${response.statusCode}): ${safeUrlForError(url)}`,
        ));
        return;
      }

      const total = Number(response.headers['content-length']) || null;
      if (expectedSize && total && total > expectedSize) {
        response.resume();
        reject(new Error(`模型下载响应超过清单大小: ${total} > ${expectedSize}`));
        return;
      }
      let downloaded = 0;
      const output = fs.createWriteStream(outputPath, { flags: 'w' });
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (expectedSize && downloaded > expectedSize) {
          const error = new Error(
            `模型下载超过清单大小，已中止: ${downloaded} > ${expectedSize}`,
          );
          response.unpipe(output);
          output.destroy(error);
          response.destroy(error);
          return;
        }
        if (onProgress) onProgress({ downloaded, total });
      });
      response.on('error', (error) => output.destroy(error));
      output.on('error', reject);
      output.on('finish', () => output.close(() => resolve({ downloaded, total })));
      response.pipe(output);
    });
    request.setTimeout(120000, () => request.destroy(
      new Error(`模型下载连接超时: ${safeUrlForError(url)}`),
    ));
    request.on('error', reject);
  });
}

async function prepareModelDirectory(modelDir = DEFAULT_MODEL_DIR, options = {}) {
  const manifest = options.manifest || SENSEVOICE_MODEL_MANIFEST;
  const downloader = options.downloader || downloadToFile;
  const before = await verifyModelDirectory(modelDir, manifest);
  if (before.ok) {
    return { ...before, downloaded: [] };
  }

  await fs.promises.mkdir(modelDir, { recursive: true });
  const downloaded = [];

  for (const invalid of before.invalid) {
    const file = manifest.files.find((candidate) => candidate.name === invalid.name);
    if (!file) continue;
    const destination = path.join(modelDir, file.name);
    const partial = `${destination}.part`;
    await fs.promises.rm(partial, { force: true });

    try {
      let lastReportedPercent = -1;
      await downloader(fileUrl(manifest, file.name), partial, {
        expectedSize: file.size,
        onProgress: ({ downloaded: bytes, total }) => {
          const expectedTotal = total || file.size;
          const percent = Math.min(100, Math.floor((bytes / expectedTotal) * 100));
          if (percent >= lastReportedPercent + 5 || percent === 100) {
            process.stdout.write(`\r[SenseVoice] ${file.name}: ${percent}%`);
            lastReportedPercent = percent;
          }
        },
      });
      if (lastReportedPercent >= 0) process.stdout.write('\n');

      const partialCheck = await verifyModelDirectory(
        path.dirname(partial),
        { ...manifest, files: [{ ...file, name: path.basename(partial) }] },
      );
      if (!partialCheck.ok) {
        throw new Error(`${file.name} 校验失败: ${JSON.stringify(partialCheck.invalid)}`);
      }
      await fs.promises.rename(partial, destination);
      downloaded.push(file.name);
    } catch (error) {
      await fs.promises.rm(partial, { force: true });
      throw error;
    }
  }

  const after = await verifyModelDirectory(modelDir, manifest);
  if (!after.ok) {
    throw new Error(`SenseVoice 模型准备不完整: ${JSON.stringify(after.invalid)}`);
  }
  return { ...after, downloaded };
}

function formatInvalid(invalid) {
  return invalid.map(({ name, reason }) => `${name}(${reason})`).join(', ');
}

async function runCli() {
  const modelDirArgument = process.argv.find((arg) => arg.startsWith('--model-dir='));
  const modelDir = modelDirArgument
    ? path.resolve(modelDirArgument.slice('--model-dir='.length))
    : DEFAULT_MODEL_DIR;

  if (process.argv.includes('--verify')) {
    const result = await verifyModelDirectory(modelDir);
    if (!result.ok) {
      throw new Error(`SenseVoice 模型校验失败: ${formatInvalid(result.invalid)}`);
    }
    console.log(`[SenseVoice] 校验通过: ${modelDir} (${result.revision})`);
    return;
  }

  const result = await prepareModelDirectory(modelDir);
  const action = result.downloaded.length > 0
    ? `已下载 ${result.downloaded.join(', ')}`
    : '已复用本地已校验模型';
  console.log(`[SenseVoice] 准备完成: ${action}; revision=${result.revision}`);
}

exports.SENSEVOICE_MODEL_MANIFEST = SENSEVOICE_MODEL_MANIFEST;
exports.DEFAULT_MODEL_DIR = DEFAULT_MODEL_DIR;
exports.downloadToFile = downloadToFile;
exports.prepareModelDirectory = prepareModelDirectory;
exports.sha256File = sha256File;
exports.verifyModelDirectory = verifyModelDirectory;

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`[SenseVoice] ${error.message}`);
    process.exitCode = 1;
  });
}
