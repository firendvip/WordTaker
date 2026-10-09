# WordTaker 1.29.5 / macOS 14 候选增量快照

时间：2026-10-09 14:30 CST。产品下限由用户明确批准为 macOS 14.0；本文记录新候选源闭包与提交前验证，不是正式发布或完整安全验收。

## 范围与历史

- 仅在隔离工作区 `/Users/Admin/.codex/worktrees/wordtaker-release-candidate/WordTaker`、分支 `codex/wordtaker-release-candidate` 修改。增量父提交为 `59390b129c6d9d1d505e9fc2e87c3bf46fbabcfe`；业务代码、共享脏树、Windows 支持范围、版本 1.29.5 与 pnpm 锁图不变。
- Electron 43.7.8 自身平台下限仍为 macOS 12；产品下限、默认门禁、缓存/构建/Python 测试/afterPack 统一为 14.0，不将 14.0.1 或 14.1 向下取整。
- 历史报告 `RELEASE_CANDIDATE_20261009.md` 保持原字节，SHA256 `9f285fe0421e3af2f6a25e2213d3322f27b425a6a64c89bea4171a0a331fee89`。旧 59390b12 包的 15 份证据哈希复验全通过；旧 Mac12 审计和旧 Windows CI 仅属历史，不能代替本提交验收。
- 新增 Mach-O thin64/fat32/fat64 目标 slice 解析保留端序、架构、完整 major/minor/patch、load command、截断/损坏/文件系统失败与 symlink 逃逸检查，不信任宿主可 import 或 wheel 标签。

## 已审原生目标依赖

- Apple Silicon / CPython 3.11：ORT 1.27.0 → 1.31.0 官方 macosx_14_0_arm64；SciPy 保持 1.17.1，选择已验字节的官方 macosx_12_0_arm64（实际最高 minos 12.3.0，满足 14.0）。URL、原始 wheel SHA、包文件数、完整包内容 SHA、METADATA/WHEEL SHA 固定在 `scripts/macOS-python-wheels.js`。
- 安装显式目标 14.0 arm64/cp311、仅二进制、require-hashes、no-deps/no-compile/no-cache；失败不回退无锁轮子。两项版本约束应用于 macOS arm64 的旧依赖解析，最后再安装固定 wheel；不套用到 Windows、Linux 或 macOS x64。
- 已实际在候选忽略目录安装两项；379 个 Python Mach-O 均满足目标。NumPy、Torch、TorchAudio、torchvision、FunASR、ModelScope 与 llama_cpp 七包的全部文件哈希前后相同。旧运行时另保留于历史 QA python-stage；唯一旧 ORT 版本元数据移至本轮 QA previous-distribution，可恢复。
- 缓存与实际包必须同时满足真实 Mach-O、两包完整内容/文件数/版本元数据和真实导入；拒绝源码或 native 改动、旧文件残留、pyc 残留、不同 wheel 和符号链接。固定 SenseVoice 四文件清单及所有大小/SHA 不变。
- 仅两项冻结，**不是全 Python 栈锁定**。Torch 2.0.1 / TorchAudio 2.0.2 / torchvision 0.15.2 和 Paraformer 保留；危险 PyTorch 模型加载链的最小迁移仍待核准。本轮不升级整栈、不执行 Paraformer checkpoint、不声称已修复 Torch 安全问题。

## 提交前实际验证

- TDD：macOS14 默认门禁、wheel 内容与调用链/约束各先失败再通过；38 项目标兼容回归、14 项 wheel 回归及模型测试联合通过。
- 全 JavaScript：32 文件 **384/384**；Windows SQLite Node **18/18**；rollback **6/6**。
- 两新增校验 helper 合计覆盖：语句 **93.93%**、分支 **90.12%**、函数 **100%**、行 **99.27%**，不代表全项目覆盖。
- lint 0 error / 367 既有 warning；渲染构建通过；冻结 lockfile 安装通过；6 个脚本 syntax 与 diff 空白检查通过。
- JS 全依赖 audit 0 critical / 0 high / 1 moderate；不外推成 Python 或整体安全合格。
- `pnpm test:python`、真实缓存导入与构建前门禁通过；Python 引擎 reporting **4/4**、本地模型完整性 **2/2**。新两包的依赖导入均使用既有隔离 prefix。
- listen-only 补丁在候选 native 重新构建；最终实际包仍需独立检查真实加载文件和汇编证据。

## 提交后必须独立验收

- 在本文所在的同一新提交构建 macOS arm64 隔离 `--dir`、执行模型/hash/Mach-O/隔离 native/包内引擎合成语音推理，并按精确新 SHA 触发 Windows x64/arm64 CI。证据保存在被 Git 忽略的 `dist/qa/mac14-compat-r1/`，不在本提交自引用未来 SHA。
- Windows workflow `contents: read`、Release 与 upload-artifact 均 false，现有 PE/模型门不变。正常候选 push/CI 不授权 main、tag、Release 或网站发布。
- **productionEligible=false**：可信 Developer ID、公证/stapling、Windows Authenticode、安全的 Torch 迁移/模型来源门和真实 macOS14 设备尚未完成。未签名包不公开，不替换/启动用户主 app，不读写真实 userData、不申请麦克风/全局热键/钥匙串权限。

## 13 个增量源码文件

- `CHANGELOG.md`
- `docs/MACOS_BUILD.md`
- `package.json`
- `scripts/check-embedded-python.js`
- `scripts/prepare-embedded-python.js`
- `scripts/test-embedded-python.js`
- `scripts/verify-sensevoice-pack.js`
- `tests/sensevoiceModel.test.js`
- `scripts/macOS-arm64-python-constraints.txt`
- `scripts/macOS-python-wheels.js`
- `scripts/macOS-runtime-compatibility.js`
- `tests/macOSPythonWheels.test.js`
- `tests/macOSRuntimeCompatibility.test.js`

另提交本文，共 14 文件；不包含 Python/models/node_modules/src-dist/QA 生成物、凭据或不相关 WIP。

## 93 文件当前源码闭包

沿用原 87 文件并仅加入六个必要门禁/测试文件；不计两份自引用 QA 报告。规范串仍为按路径排序的 `SHA256 + 两空格 + path + LF`，集合 SHA256：`fc027471daf193459fa150e2f02c84ccb6ff4e753ce4d3c7036969412294583e`。

```text
ffca7ecedeba2951e88abfb3c4d41631fc16299727e7f27cd7d105b754e2745c  .github/workflows/build-windows.yml
ca7c2420bb0593ed3100b048f63791480fcbd80c11941d42ff2d3741cea52912  .github/workflows/ci.yml
5efd07db28ae5d97a64ad10522600575a65b5cec07b04470f97ebfd93275ee9e  CHANGELOG.md
1c6194cc785ca3739b543f67297aafeb1fcb152a749e86410c43fb81fc88bdf3  assets/cat-avatar-transparent.svg
7f12c95f84ef1bc30e073a710869f0b9ffb8d13fddef09f97850a9fe850d294f  docs/CLIENT_INTEGRATION_SPEC.md
fc5cf8217412aed2e55524d78e2322c0c55c7609b5eed67c45476b8f5636f3af  docs/DEPENDENCY_SECURITY.md
c026b0dffb74c2bd318f5b693a7e51e9e499748a60363553891e4bf9e9e973be  docs/MACOS_BUILD.md
6140cab02583c41ce60fc4c21038931f082f8362b8c16986bc2d74e5cf9c0b69  docs/WINDOWS_BUILD.md
d3a58549db061ead1dc30a351e1f9534f37d3243cfefa1aeb95075aa4fcfe80a  funasr_server.py
228b99ab36842d8e91745c4dd6ff1fb0cea586d719237a91b44636586bd75bff  llm_server.py
1cce973843f5b4469e6eb886b482af33a59ca80500382611d24bb5600e923bb7  main.js
8281893acb5b34e4e4f7b50daee8b805de9fd0a8ac205b38b838d95599f798a7  package.json
00367e68fe369af79db3839ae66fbbb4ec1dc69d9e1ef1ef782422ef11c5a3bc  pnpm-lock.yaml
1fc6449ef3e2c24bda4558dc8de32490a92aae2219f4477ae6283d838d7f071f  pnpm-workspace.yaml
1ce5ee8ac1a9f0a02a17650ad7cb7137b8be620527da08ba928abfb1efb746ad  preload.js
cdb963d64eee1050ff56e4c9b2df406e9a0bd3ef783b236d94e5e71a9c8b66cc  relay/tencent-scf-web/promptPolicy.js
3aa592fce509f7060af763bf213ee2bc0877c30b783dd5d566d990c0b62a18f7  relay/tencent-scf-web/server.js
d3635fb9f7f806684aa39b2ed170caae1ffa1df5a4ef50d11986564dc2c57b64  relay/worker.js
b535e238b1fcb56eaf9d6628fa3e09dbb6332977d58bea6fea4e59a9b567af5c  scripts/check-embedded-python.js
b3a126b8f3e5f499c2cdffb3ae27fab140fc8db6808109376eeb28fb0b226699  scripts/find-electron-rebuild.cjs
79d8043bc9d565f5f5cc2c66408ead630ec1a014e56a16ff9c236d93148591a0  scripts/macOS-arm64-python-constraints.txt
58c23803e7fd85454bd28aad1417da54863953b8389d63348749362b63306a36  scripts/macOS-python-wheels.js
e74ccccfee48316737f4a366e06145ef3f60382cf6b52657e290f1093e390799  scripts/macOS-runtime-compatibility.js
68835d016158dac0d61ab93abb59497fd3b2703e15838ec9cb0240c9361ed91e  scripts/prepare-embedded-python.js
af99106c482d15bd64d5652170e569fdb179f7e50be656d02247c8019a07287d  scripts/sensevoice-model.js
78e7eae4f85a728f916fe1e0ea74a7fd6ef75f8790cd4c83114a6aff2072de75  scripts/smoke-sensevoice.py
e75b442eeb18d7a1dd881b617fca67223ad23925fef84e89be4d2655056356b1  scripts/test-embedded-python.js
b64708fd817b95c317f9900bddbfc2961f8abf45fd3bba6c8bae58c828375c9b  scripts/verify-desktop-runtime.js
06c3a32524e1e4418d88efe3c4368d32cab478c48e004cf99edaa1caf01ced7a  scripts/verify-sensevoice-pack.js
8840becd6af128f0fa3b1e8efd511c606271a44c7b27aee6484470e457226269  src/App.jsx
de015c488f5c6a3065d7ccff7b863af91a9ce678fc3b01d5a6a598e885e9070a  src/components/CatSkin.jsx
e4bd40b5d54d58e8b91bc8c8400c7fbe27c8480505ab2142356b12d9ef4ceca2  src/components/CatSkinFx.jsx
46c8a7b4589eebec178eae2d7f0e1841beb595862596ac5f010a67fc19eef74f  src/components/QuotaExhaustedBubble.jsx
ffaa863c572c566560be38f0ee4c9af93cf0b239df9ea6c3eab8a345098b770b  src/components/RecorderPill.jsx
194a89d11ffc617ea78623a9040d78710042be0d9df877151d81803f8af503b3  src/components/account/AccountPanel.jsx
73857f14cd48e122b91b858a03abe95355867498d279745aa8579fdae57c6a84  src/components/account/MembershipHero.jsx
32cba69cc0a50d055dbbb2d30b9c0bd17c7b69b01df28929c4d315896082d6f2  src/components/account/PayQrModal.jsx
8d2b80751159ede7a43e0173c4e456bfd2174039e8c85b2e48d3d14f9934d30c  src/components/account/PlansCard.jsx
48e7cb4cd65df4678573fb61771320402d4ed1fcde1758812b258d795738eb0b  src/helpers/aiService.js
ae81974712fdb5c04937bcb3cb321751a29cac064529c6ba7772fb2abcb64cc3  src/helpers/backendClient.js
6e691a2874f2791bd721463376bacf6d5135d40f12c968060181b92b7686106a  src/helpers/backendConfig.js
95554d4e797b6d856afbfd4acd31615391a4a0f77ae30b97b8a88d10bf653c13  src/helpers/database.js
e1bf801cd8d1208b7634afa97dd60568003d3d4898c0d00bac1202960d2b3935  src/helpers/funasrManager.js
5cfd25267e4445cd932b25bb8794321333f5ea9e0b66dd73f2c10af616dbe7b7  src/helpers/ipcHandlers.js
abff93957232156fc2f6711a2c291de3549f599e489613cd16abddc44c12b905  src/helpers/llmManager.js
87783cf64c0d13b033f8022376d2b53d04112161b415041cedbd011d26d37088  src/helpers/tokenStore.js
36d99ccb5fd14a0e1360b48c164e9d89be6b5229bb4f103ff9cac742dd9fc80a  src/helpers/windowManager.js
f66a60bce4d767724dfdc6e691e110639f0cc86e107aebf96bf5a8e1059b0958  src/history.html
916c030aac99f4e8669422dff2133d36238de6227b4c8e8f3376ba43e7a9d489  src/history.jsx
87b76cc1f9bb400b9a7ec0d293b147307feb3fdbebfb370d237e36f63c4a1d8b  src/hooks/usePrefersReducedMotion.js
4422efb92823a29c08f95a60ae2f5875159dfc8bc1ffe30d5d5ef8829a41b8e2  src/hooks/useRecording.js
480a35a07494cf52fe784d1f5100f1156721a7600028a4abb9650a5bf552d09e  src/index.css
65dfa6d5b1e40302bc0fa3493d3795bf57c786fce20dd6120d04e272a865cd51  src/index.html
e04d60e2c832b7a1b7bec3a361399ac153269ee4a0a014f78e4cff2b626fee63  src/settings.html
82259713c8b0ce721fd8481d2fa12c2f7f7b7a38a6a102dcc40e57628a1085d6  src/settings.jsx
4be869e10d4cab6370a47dc652dd80d32fb4df3c8e903cae92e77831af2f43a0  src/utils/appTitle.js
8bd3e8607f9485b03a0f2b080bd6c0984f4c1ad36bdb94b224f28c8110465aba  src/utils/audioLevel.js
9c2d3ae5e647b2327bbf0b8d61f5b87c156122fea95064258bd7645a431fdd34  src/utils/historyPerformance.js
4058043b3f8d33c5a64222188825676f12392f4e9ca47dc6f638cdc02b50711f  src/utils/quotaReminder.js
a994139ecc882a06a722cbd0bcc6212dde80e38fd04f777642aa81caef4122f7  src/utils/recorderAnimation.js
612d89a91a8bde31c34fb31a914a1691cdd253d2e10aa96e54d2b63c3d1e5ca8  src/utils/shortTextPolicy.cjs
2de4060aa7a63fde9f9857535aaf0160cce3abf09312cd56d4a1d76f95a2eef3  src/utils/skipPolish.js
ca1f60d9a9f963a9ae693261a67859ccfd7edafea02148100ccdae85f889a257  tests/aiService.test.js
123ae4d7355cfdd42ed6659105f1bc854f35e274cc8e6140e870ccbbcd913e0f  tests/appTitle.test.js
4962757bd1627399dc62ad0f7581b06e9fefe699b5d377591e2a81890f9e9fd1  tests/audioLevel.test.js
bce2416cf5379bc2232c1f1fc8f1a1335fc40fbc32d57ddf244da4b25ff07bad  tests/authSessionPersistence.test.js
841854b2ad8901a6edc9dcb2f94250c65ed1f87c81e5ccd9a1f325a029650ec5  tests/backendConfig.test.js
59616fa4f2a0270783e5589b5b3dd49fb1c34c85cacbfb5ec8b2f49cd98514df  tests/dependencySecurity.test.js
2f15fae49d6e0d1cf9045cd2ecd29b233aa1ce58927c0ba7053d23e2b7693899  tests/funasrLocalModels.test.js
b940e87c132612cd2edb81461a9e9048e4e7d5b6c2c62c4a302a98024c89c1af  tests/funasrManager.engineReporting.test.js
f7b358cead7bf06c97b274e6c20f5294f8bf76246c911aa7f297aa26ca9bade6  tests/historyPerformance.test.js
1b753ffa8c45fcacc5167031b8afe9f359b58e3c91e0fc37d7096ac260e44cd9  tests/localNormalPromptPolicy.test.js
9b6fb13ff899df91fda792c334866d456be487c519df80cc19c002f43411ddbe  tests/macOSPythonWheels.test.js
318ccbffd1ce7c88cb6d0bb08a76abd508699e1a9420fcbe785b91708206c25e  tests/macOSRuntimeCompatibility.test.js
1e5d37ea5cd2b4ba2b86e28f23597a18939a91972d18819f77d31ec3febab98d  tests/normalPromptPolicy.test.js
efcc775d2415edeec30928633ea19bfe5ae4535e0f28ddf06b2aa908501fd796  tests/paymentBridge.test.js
8939c45a0a64637b2eba8fb446404635711b9d941a32f51bf4c10413f0725fa3  tests/paymentFlow.test.jsx
dcf59f1603a2345e84dde006ff17784b5e21f5f317ce7cbeeb1e6b0e40c7cc72  tests/phoneLoginBoundary.test.js
df63c1737c7fbc7f77333dcc1a0465b5604acbe6c66a23db1e4ce46bb2411e9c  tests/phoneLoginPanel.test.jsx
ffbed4a6b99437fd1142060b7281db1bba38fd8d4fd6f9afc8623987ccd06365  tests/phoneMembershipHero.test.jsx
6c32759bd94a8aadc4fbaf54fda636a7a0cd35b542784266254a069448f89ecc  tests/quotaReminder.test.js
32c7600b5c9964253b343bd7fd4e3949ff43aee3b68e158c875be6a47d749569  tests/recorderAnimation.test.js
d7995a76d5c22e38fcd0d623895a60d32e1ad6ba0d1b44e4728e1a903ce8a0f9  tests/recorderCancellation.test.js
c16fabe51536621e12bfce20ffb14fc19312cb2320b1e4b4935e65fa6fac0354  tests/recorderWindowVisibility.test.js
3e0272b040e5f80057eb4a447a56bd9b032ab5819bbb93c278eaa84e1bd02026  tests/recordingStartup.test.js
4321241ffdf9cb50bd377119b2cbab27c790765c298088a4d36947b3837fd6bd  tests/roleSelection.test.jsx
743ff224269c19a8a53a9c1bb12e36d839ad49e7299c9e47c9bf18dca7e87ca4  tests/roleSettings.test.js
cbd9bb984aa289a9bebe65100dce79492668c59778d4c45574fa6b850ae5607d  tests/sensevoiceModel.test.js
753cfaf72a6df41ff60c19d0927678762eef06e4ce349332ff9076d90e3062f4  tests/settingsTitleEntry.test.js
984b59b918dfbb751f7f6bb57a1642796a83b467b613cbde9760cb13d1327151  tests/skipPolish.test.js
91fefd497592f38c81de9bc42f3194d17b47154195ea600b4d04be15c256c92d  tests/test_funasr_local_models.py
20b911f5c44619592c5cc3e66f5c2c5cf0140c5c5e6ab0dba39ecc8c240fc254  tests/windowsSqliteBinaries.test.cjs
74b9592651625da1d97843e98735781e5585ebca27fb3fc97bc0d03f4ab0d19f  vitest.config.mjs
```

