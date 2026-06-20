const fs = require('fs');
const path = require('path');

// 项目根目录：脚本位于 scripts/，上一级即根目录
const projectRoot = path.join(__dirname, '..');
const pythonPath = path.join(projectRoot, 'python', 'bin', 'python3.11');

try {
  // 文件必须存在且可执行
  fs.accessSync(pythonPath, fs.constants.X_OK);
  console.log('[check-embedded-python] OK: python/bin/python3.11 存在且可执行');
  process.exit(0);
} catch (error) {
  console.error('[check-embedded-python] 缺少内置 Python，请先运行: npm run prepare:python:embedded');
  process.exit(1);
}
