const fs = require('fs');
const path = require('path');
const { verifyMacOSRuntime } = require('./macOS-runtime-compatibility');
const { verifyMacOSPythonWheels } = require('./macOS-python-wheels');

// 项目根目录：脚本位于 scripts/，上一级即根目录
const projectRoot = path.join(__dirname, '..');
const pythonPath = path.join(projectRoot, 'python', 'bin', 'python3.11');

try {
  // 文件必须存在且可执行
  fs.accessSync(pythonPath, fs.constants.X_OK);
  if (process.platform === 'darwin') {
    verifyMacOSRuntime(path.join(projectRoot, 'python'), { arch: process.arch });
    verifyMacOSPythonWheels(path.join(projectRoot, 'python'), { arch: process.arch });
  }
  console.log('[check-embedded-python] OK: python/bin/python3.11 存在且可执行');
  process.exit(0);
} catch (error) {
  console.error('[check-embedded-python] 内置 Python 缺失或不符合目标环境，请检查后运行: npm run prepare:python:embedded');
  console.error(error.message);
  process.exit(1);
}
