# dsh-session-files v0.2.0

## 新增:模型在对话中提供文件下载

- 新模型工具 `share_session_file(path, name?, description?)`:模型把工作区内任意文件
  (绝对路径或相对 cwd)登记为「可下载」;用户索要文件或模型交付成品时使用。
- 对话流内渲染**文件下载卡片**(tool.call.toolview 按工具名 keyed 替换通用行):
  显示文件名、类型、大小与一句话说明,点击卡片即下载保存;卡片随工具调用历史
  持久化,会话恢复后依然可见。
- 下载端点扩展:`GET /file?sessionId=..&path=..` 支持工作区内任意文件
  (严格防越界:拒绝 `..`、绝对路径越出 cwd);`name`/`path` 模式互斥且必须给一个。
- 新增 `GET /share-info?sessionId=..&path=..`:文件元信息(名称/类型/大小/相对路径),
  供卡片异步补全信息并在文件被删除时标记「文件已不存在」。
- 引导消息(上传成功 + 会话启动)追加 share_session_file 用法提示,模型在用户
  要求「发文件」时知道该调用本工具而不是只报路径。
- 工具安全:路径必须解析到会话 cwd 内;只接受普通文件;超 maxUploadBytes 拒绝;
  显示名经 sanitizeFileName 净化。

## 沿用

- 上传、文件芯片 dock、设置页、注入引导等 v0.1.0 行为不变。

## 验证

- 集成测试 85/85(test/test-host.mjs):覆盖工具注册/参数 schema/执行边界
  (越界/缺失/目录/超限/跨会话)、输出渲染、path 下载与 share-info 端点。