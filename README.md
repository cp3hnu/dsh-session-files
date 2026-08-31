# Session Files — DSH 会话文件的任意文件上传

> npm 包名 / 仓库名 `@deepseek-ai/dsh-session-files`。

让用户可以在 DSH Web 界面里给当前会话上传**任意文件**(不限图片),并把文件落到**本会话工作区**的专用目录:

```
<session.workspace>/uploads/<sessionId>/<文件名>
```

- `<session.workspace>`:当前会话的工作目录(session cwd);
- `uploads/`:专门存放此类内容的目录(约定名,可通过代码顶部常量调整);
- `<sessionId>/`:对应该 session 的子目录。

上传成功后插件自动向该会话注入一条消息,引导 LLM 知道「哪一个目录对应本 session」并提供文件清单;会话恢复时若该目录已存在,也会再次提示模型。

## 特性

- 🖇 聊天输入区左侧新增「上传文件」按钮(DSH 官方回形针图标),支持多选、任意类型(文本/PDF/压缩包/音视频/二进制…)
- 📁 文件落在 `<workspace>/uploads/<sessionId>/`,只有用户真正上传时才创建目录(无上传则目录不存在)
- 🧠 上传成功后经 `agent.inject` 注入模型可见消息:会话上传目录绝对路径 + 相对路径约定 + 文件清单
- 🔁 会话启动/恢复时,若上传目录已存在,自动注入同等的目录提示(休眠会话也能知道该看哪里)
- 🗂 输入区上方 dock 显示已上传文件芯片:点击打开/预览,× 删除
- 📥 文件可通过浏览器直接下载(文本/图片/PDF 内联预览,其余附件下载)
- 🎁 **模型提供文件下载**(v0.2.0):模型调用 `share_session_file` 工具即可把工作区内
  任意文件(处理结果等)递到对话流——渲染为可点击的下载卡片(文件名/类型/大小/说明),
  会话恢复后卡片依然可见
- ⚙️ 设置页可配:启用开关、是否显示文件 dock;展示单文件大小上限
- 🔐 安全:sessionId 白名单 + 文件名净化;path 下载/分享严格锁定在会话工作区内
  (拒绝 `..`、越出 cwd 的绝对路径);单文件大小上限默认 512 MiB

## 界面

- 输入区左侧(会话存在时):回形针图标按钮,上传中显示剩余计数角标
- 输入区上方 dock:「已上传 N」+ 文件芯片(名称/大小/删除),以及「本会话上传目录」的绝对路径
- 对话流:模型调用 `share_session_file` 后,该条工具调用渲染为文件卡片
  (图标 + 文件名 + 类型/大小 + 说明 + 「下载」按钮),点击即保存
- 设置:「设置 → 会话文件上传」

## 安装(官方方式)

前置:dsh 已安装且目标 profile(默认 `web`)在运行。本插件通过官方的 `dsh plugin add` 安装(`dsh plugin` 是 pnpm 的薄转发层);包内声明了 `dsh.bundle.patch`(自带 `cordis.patch.yml`),因此 **`plugin add` 一步即可完成安装,无需手动编辑任何 profile 配置**。

```bash
# 方式一:仓库脚本(自动 npm pack + dsh plugin add)
bash install.sh

# 方式二:手动执行官方命令
npm pack -y                        # 产物 deepseek-ai-dsh-session-files-<ver>.tgz
dsh --profile web plugin add ./deepseek-ai-dsh-session-files-<ver>.tgz
```

安装成功后**重启 dsh**(让 profile 重新组合 bundle 层),刷新浏览器即可在输入区左侧看到 📎 按钮。

## 验证

重启并刷新页面后:

- 打开一个会话,输入区左侧出现 📎;点它选任意文件上传,输入区上方出现「已上传 N」芯片;
- 命令行核对(把 `<dsh-address>` 换成你实际访问 dsh 的地址):
  ```bash
  # 客户端插件已加载(应以 window.__ModuleLoader__.load( 开头)
  curl -s http://<dsh-address>/plugins/@deepseek-ai/dsh-session-files/client.js | head -c 80
  # 配置端点
  curl -s http://<dsh-address>/dsh-session-files/config
  # 列表端点(目录不存在时返回空列表,不创建目录)
  curl -s 'http://<dsh-address>/dsh-session-files/list?sessionId=<某会话id>'
  ```
- 工作区核对:`` `ls <workspace>/uploads/<sessionId>/` `` 应能看到刚上传的文件;未上传过的会话不应存在 `uploads/<sessionId>/` 目录

## 目录与模型引导

- 上传目录固定为会话 cwd 下的 `uploads/<sessionId>/`,模型可通过 fs 工具直接访问(相对 cwd 或绝对路径);
- 上传成功后注入的模型可见消息包含:目录绝对路径、相对路径约定、本次文件清单,以及「用户提到上传的文件时,先列目录再按需读取」的指引;
- 会话启动/恢复时(`agent/session-start`)若目录已存在,注入同类提示;目录不存在则不做任何事(也不会创建);
- 引导消息同时告知 `share_session_file` 工具:用户索要文件时,应调用它(而不是只报路径)。

## 安全说明

- `sessionId` 必须匹配 `[A-Za-z0-9._-]{1,80}` 且是当前已加载的会话;
- 文件名只取叶子名,拒绝路径分隔符、控制字符、`.`/`..`、隐藏文件与超长名;
- 单文件大小上限默认 512 MiB(`uploads` 目录在首次上传时创建,临时文件写在同一目录并以 `.part-` 前缀隔离,成功后原子 rename);
- 下载端点做了类型映射与目录锁定,GET 只能读取该会话目录内的文件。

## 卸载(官方方式)

```bash
dsh --profile web plugin remove @deepseek-ai/dsh-session-files
```

随后重启 dsh 并刷新页面;`plugin remove` 会自动把本插件从 `dsh.profile.bundles` 层移除(不再加载),无需手动清理配置。已上传的文件保留在 `uploads/<sessionId>/`,不会被删除。

## 打包与发布

```bash
npm pack          # 产物 deepseek-ai-dsh-session-files-<ver>.tgz
```

发布到 npm 前把 `package.json` 的 `"private": true` 去掉。发布到 GitHub:
仓库即本目录(不含 `node_modules/`);tgz 可保留在仓库中作为安装资产,
或改用 GitHub Releases 附件 + 仓库内保留 `install.sh` 与文档。更新发行物时
请同时新增 `RELEASE_NOTES-v<ver>.md` 并更新本 README 与 GITHUB_INTRO.md。

## License

[MIT](LICENSE.md)