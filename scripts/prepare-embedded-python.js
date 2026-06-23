const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const tar = require('tar');

const pipelineAsync = promisify(pipeline);

class EmbeddedPythonBuilder {
  constructor() {
    this.pythonVersion = '3.11.6';
    this.buildDate = '20231002';
    this.pythonDir = path.join(__dirname, '..', 'python');
    this.forceReinstall = false;

    // 目标平台：默认当前平台，可用 --platform=win32|darwin|linux 覆盖（跨平台准备无意义，
    // 因为依赖里有原生轮子，但保留开关便于排错/CI 显式指定）。
    this.targetPlatform = process.platform;
    const platArg = process.argv.find((a) => a.startsWith('--platform='));
    if (platArg) this.targetPlatform = platArg.split('=')[1];
    this.isWindows = this.targetPlatform === 'win32';
  }

  // 嵌入式 Python 可执行文件路径（跨平台）。
  pythonExecPath() {
    return this.isWindows
      ? path.join(this.pythonDir, 'python.exe')
      : path.join(this.pythonDir, 'bin', 'python3.11');
  }

  // site-packages 路径（跨平台）。
  sitePackagesPath() {
    return this.isWindows
      ? path.join(this.pythonDir, 'Lib', 'site-packages')
      : path.join(this.pythonDir, 'lib', 'python3.11', 'site-packages');
  }

  // pip 安装/校验时的环境变量（跨平台）。
  pythonEnv() {
    const env = {
      ...process.env,
      PYTHONHOME: this.pythonDir,
      PYTHONPATH: this.sitePackagesPath(),
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PIP_NO_CACHE_DIR: '1',
    };
    if (this.isWindows) {
      // Windows 原生 DLL 解析需要 python 根目录在 PATH 头部
      env.PATH = `${this.pythonDir};${path.join(this.pythonDir, 'Scripts')};${process.env.PATH || ''}`;
    } else {
      env.LD_LIBRARY_PATH = path.join(this.pythonDir, 'lib');
      env.DYLD_LIBRARY_PATH = path.join(this.pythonDir, 'lib');
    }
    delete env.PYTHONUSERBASE;
    delete env.PYTHONSTARTUP;
    delete env.VIRTUAL_ENV;
    return env;
  }

  async build() {
    console.log('🐍 开始准备嵌入式Python环境...');
    
    try {
      // 1. 检查现有环境是否完整（除非强制重新安装）
      if (!this.forceReinstall) {
        const existingInfo = await this.getEmbeddedPythonInfo();
        if (existingInfo && existingInfo.ready) {
          console.log('✅ 检测到现有的嵌入式Python环境:');
          console.log(`   版本: ${existingInfo.version}`);
          console.log(`   大小: ${existingInfo.size.mb}MB (${existingInfo.size.files} 个文件)`);
          
          // 验证关键依赖是否完整
          const pythonPath = this.pythonExecPath();
          const isValid = await this.validateExistingEnvironment(pythonPath);
          
          if (isValid) {
            console.log('✅ 现有环境验证通过，跳过重新安装');
            return;
          } else {
            console.log('⚠️ 现有环境不完整，将重新安装...');
          }
        } else {
          console.log('📋 未检测到现有环境或环境不可用，开始全新安装...');
        }
      } else {
        console.log('🔄 强制重新安装模式，跳过现有环境检查');
      }
      
      // 2. 清理现有Python目录
      await this.cleanup();
      
      // 3. 下载Python运行时
      await this.downloadPythonRuntime();
      
      // 4. 安装Python依赖
      await this.installDependencies();
      
      // 5. 清理不必要文件
      await this.cleanupUnnecessaryFiles();
      
      console.log('✅ 嵌入式Python环境准备完成！');
      
    } catch (error) {
      console.error('❌ 准备Python环境失败:', error.message);
      process.exit(1);
    }
  }

  async cleanup() {
    if (fs.existsSync(this.pythonDir)) {
      console.log('🧹 清理现有Python目录...');
      fs.rmSync(this.pythonDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.pythonDir, { recursive: true });
  }

  // 按目标平台拼出 python-build-standalone 的 install_only 包名（跨平台）。
  // 三个平台的命名约定：
  //   darwin: cpython-X+DATE-<arch>-apple-darwin-install_only.tar.gz
  //   win32:  cpython-X+DATE-x86_64-pc-windows-msvc-shared-install_only.tar.gz
  //   linux:  cpython-X+DATE-x86_64-unknown-linux-gnu-install_only.tar.gz
  buildRuntimeFilename() {
    if (this.isWindows) {
      // Windows 仅提供 x86_64 的 install_only 包
      return `cpython-${this.pythonVersion}+${this.buildDate}-x86_64-pc-windows-msvc-shared-install_only.tar.gz`;
    }
    if (this.targetPlatform === 'linux') {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      return `cpython-${this.pythonVersion}+${this.buildDate}-${arch}-unknown-linux-gnu-install_only.tar.gz`;
    }
    // darwin
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    return `cpython-${this.pythonVersion}+${this.buildDate}-${arch}-apple-darwin-install_only.tar.gz`;
  }

  async downloadPythonRuntime() {
    const filename = this.buildRuntimeFilename();
    const url = `https://github.com/indygreg/python-build-standalone/releases/download/${this.buildDate}/${filename}`;
    const tarPath = path.join(this.pythonDir, 'python.tar.gz');

    console.log(`📥 下载Python运行时 (${this.targetPlatform}/${process.arch})...`);
    console.log(`URL: ${url}`);

    await this.downloadFile(url, tarPath);
    
    console.log('📦 解压Python运行时...');
    await tar.extract({
      file: tarPath,
      cwd: this.pythonDir,
      strip: 1
    });

    // 删除压缩包
    fs.unlinkSync(tarPath);
    
    console.log('✅ Python运行时下载完成');
  }

  async downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(outputPath);
      
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // 处理重定向
          return this.downloadFile(response.headers.location, outputPath)
            .then(resolve)
            .catch(reject);
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            const progress = Math.round((downloadedSize / totalSize) * 100);
            process.stdout.write(`\r进度: ${progress}% (${Math.round(downloadedSize / 1024 / 1024)}MB / ${Math.round(totalSize / 1024 / 1024)}MB)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\n✅ 下载完成');
          resolve();
        });

        file.on('error', (error) => {
          fs.unlink(outputPath, () => {}); // 错误时清理
          reject(error);
        });

      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  async installDependencies() {
    const pythonPath = this.pythonExecPath();
    const sitePackagesPath = this.sitePackagesPath();

    console.log('📦 安装Python依赖...');

    // Windows 的 site-packages 目录可能尚不存在，--target 安装前先建好
    if (!fs.existsSync(sitePackagesPath)) {
      fs.mkdirSync(sitePackagesPath, { recursive: true });
    }

    // 确保pip是最新的
    console.log('⬆️ 升级pip...');
    try {
      execSync(`"${pythonPath}" -m pip install --upgrade pip`, {
        stdio: 'inherit',
        env: this.pythonEnv()
      });
    } catch (error) {
      console.warn('⚠️ pip升级失败，继续安装依赖...');
    }

    // 定义依赖列表 - 确保numpy等核心依赖被正确安装。
    // 每项: { spec: 包约束, extraArgs?: 额外 pip 参数 }。
    // torch 系用 CPU-only 轮子（--index-url .../whl/cpu），体积更小，ONNX 推理路径不需要 CUDA。
    // funasr_onnx + onnxruntime 是 SenseVoice ONNX 推理引擎（funasr_server.py:136 导入 funasr_onnx），
    // 缺失会导致运行时 ImportError，识别只能回退 Paraformer 甚至失败。
    const CPU_TORCH_INDEX = '--index-url https://download.pytorch.org/whl/cpu';
    const dependencies = [
      { spec: 'numpy<2' },  // 先安装numpy，作为其他库的基础依赖
      { spec: 'torch==2.0.1', extraArgs: CPU_TORCH_INDEX },
      { spec: 'torchaudio==2.0.2', extraArgs: CPU_TORCH_INDEX },
      { spec: 'torchvision==0.15.2', extraArgs: CPU_TORCH_INDEX },
      { spec: 'librosa>=0.11.0' },
      { spec: 'funasr>=1.2.7' },
      { spec: 'onnxruntime>=1.16.0' },   // ONNX 运行时（CPU）
      { spec: 'funasr_onnx>=0.4.1' },    // SenseVoice ONNX 封装
    ];

    // 逐个安装依赖（包含所有子依赖）
    for (const dep of dependencies) {
      const spec = dep.spec;
      const extra = dep.extraArgs ? ` ${dep.extraArgs}` : '';
      console.log(`📦 安装 ${spec}...`);
      try {
        // 构建完整的环境变量（跨平台）
        const installEnv = this.pythonEnv();

        execSync(`"${pythonPath}" -m pip install --target "${sitePackagesPath}" --no-deps --force-reinstall "${spec}"${extra}`, {
          stdio: 'inherit',
          env: installEnv
        });

        // 安装依赖的依赖
        execSync(`"${pythonPath}" -m pip install --target "${sitePackagesPath}" --only-binary=all "${spec}"${extra}`, {
          stdio: 'inherit',
          env: installEnv
        });

        console.log(`✅ ${spec} 安装完成`);
      } catch (error) {
        console.error(`❌ ${spec} 安装失败:`, error.message);
        // 尝试不使用 --no-deps 重新安装
        try {
          console.log(`🔄 重试安装 ${spec} (包含依赖)...`);
          const installEnv = this.pythonEnv();

          execSync(`"${pythonPath}" -m pip install --target "${sitePackagesPath}" --force-reinstall "${spec}"${extra}`, {
            stdio: 'inherit',
            env: installEnv
          });
          console.log(`✅ ${spec} 重试安装成功`);
        } catch (retryError) {
          console.error(`❌ ${spec} 重试安装也失败:`, retryError.message);
          // 继续安装其他依赖
        }
      }
    }

    // 验证关键依赖
    await this.verifyDependencies(pythonPath);
  }

  async verifyDependencies(pythonPath) {
    console.log('🔍 验证依赖安装...');
    
    const criticalDeps = ['numpy', 'torch', 'librosa', 'funasr', 'onnxruntime', 'funasr_onnx'];

    for (const dep of criticalDeps) {
      try {
        const verifyEnv = this.pythonEnv();

        const result = execSync(`"${pythonPath}" -c "import ${dep}; print('${dep} OK')"`, {
          stdio: 'pipe',
          env: verifyEnv
        });
        
        console.log(`✅ ${dep} 验证通过: ${result.toString().trim()}`);
      } catch (error) {
        console.error(`❌ ${dep} 验证失败:`, error.message);
        console.error('错误输出:', error.stderr?.toString() || '无');
        throw new Error(`关键依赖 ${dep} 安装失败: ${error.message}`);
      }
    }
  }

  async validateExistingEnvironment(pythonPath) {
    console.log('🔍 验证现有环境完整性...');
    
    try {
      // 检查Python可执行文件是否存在
      if (!fs.existsSync(pythonPath)) {
        console.log('❌ Python可执行文件不存在');
        return false;
      }
      
      // 检查关键依赖是否可用
      const criticalDeps = ['numpy', 'torch', 'librosa', 'funasr', 'onnxruntime', 'funasr_onnx'];
      const verifyEnv = this.pythonEnv();

      for (const dep of criticalDeps) {
        try {
          execSync(`"${pythonPath}" -c "import ${dep}; print('${dep} OK')"`, {
            stdio: 'pipe',
            env: verifyEnv,
            timeout: 10000 // 10秒超时
          });
          console.log(`✅ ${dep} 可用`);
        } catch (error) {
          console.log(`❌ ${dep} 不可用: ${error.message}`);
          return false;
        }
      }
      
      console.log('✅ 现有环境验证完成，所有关键依赖都可用');
      return true;
      
    } catch (error) {
      console.log(`❌ 环境验证失败: ${error.message}`);
      return false;
    }
  }

  async cleanupUnnecessaryFiles() {
    console.log('🧹 清理不必要文件...');
    
    // stdlib 目录：Windows 为 python/Lib，macOS/Linux 为 python/lib/python3.11
    const stdlibDir = this.isWindows
      ? path.join(this.pythonDir, 'Lib')
      : path.join(this.pythonDir, 'lib', 'python3.11');

    const unnecessaryPaths = [
      path.join(this.pythonDir, 'share', 'doc'),
      path.join(this.pythonDir, 'share', 'man'),
      path.join(this.pythonDir, 'include'),
      path.join(this.pythonDir, 'lib', 'pkgconfig'),
      path.join(stdlibDir, 'test'),
      path.join(stdlibDir, 'distutils'),
    ];

    for (const unnecessaryPath of unnecessaryPaths) {
      if (fs.existsSync(unnecessaryPath)) {
        try {
          fs.rmSync(unnecessaryPath, { recursive: true, force: true });
          console.log(`🗑️ 删除: ${path.relative(this.pythonDir, unnecessaryPath)}`);
        } catch (error) {
          console.warn(`⚠️ 无法删除: ${unnecessaryPath}`);
        }
      }
    }

    // 删除.pyc文件
    this.deletePycFiles(this.pythonDir);
    
    console.log('✅ 清理完成');
  }

  deletePycFiles(dir) {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (item === '__pycache__') {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          this.deletePycFiles(fullPath);
        }
      } else if (item.endsWith('.pyc')) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  async getEmbeddedPythonInfo() {
    const pythonPath = this.pythonExecPath();

    if (!fs.existsSync(pythonPath)) {
      return null;
    }

    try {
      const version = execSync(`"${pythonPath}" --version`, {
        encoding: 'utf8',
        env: this.pythonEnv()
      }).trim();
      
      const sizeInfo = this.getDirectorySize(this.pythonDir);
      
      return {
        version,
        path: pythonPath,
        size: sizeInfo,
        ready: true
      };
    } catch (error) {
      return {
        ready: false,
        error: error.message
      };
    }
  }

  getDirectorySize(dirPath) {
    let totalSize = 0;
    let fileCount = 0;

    const calculateSize = (dir) => {
      const items = fs.readdirSync(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          calculateSize(fullPath);
        } else {
          totalSize += stat.size;
          fileCount++;
        }
      }
    };

    calculateSize(dirPath);
    
    return {
      bytes: totalSize,
      mb: Math.round(totalSize / 1024 / 1024),
      files: fileCount
    };
  }
}

// 主函数
async function main() {
  const builder = new EmbeddedPythonBuilder();
  
  if (process.argv.includes('--info')) {
    const info = await builder.getEmbeddedPythonInfo();
    console.log('嵌入式Python信息:', JSON.stringify(info, null, 2));
    return;
  }
  
  // 检查是否强制重新安装
  if (process.argv.includes('--force')) {
    console.log('🔄 强制重新安装模式');
    builder.forceReinstall = true;
  }
  
  await builder.build();
  
  // 显示最终信息
  const info = await builder.getEmbeddedPythonInfo();
  console.log('\n📊 嵌入式Python环境信息:');
  console.log(`版本: ${info.version}`);
  console.log(`路径: ${info.path}`);
  console.log(`大小: ${info.size.mb}MB (${info.size.files} 个文件)`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = EmbeddedPythonBuilder;