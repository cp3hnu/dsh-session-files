# dsh-session-files v0.1.0

## 新增

- 聊天输入区左侧「📎 上传文件」按钮(conversation.input.left),支持多选、任意类型、上传进度角标;
- 文件落盘约定:`<session.workspace>/uploads/<sessionId>/<name>`(仅首次上传时创建目录);
- 上传成功后 `agent.inject` 注入模型可见消息:本会话上传目录(绝对 + 相对路径)、文件清单、读取指引;
- `agent/session-start` 时若上传目录已存在则注入同等提示(会话恢复后模型仍知道目录);目录不存在时零副作用;
- 输入区 dock(conversation.input.dock)文件芯片:预览/下载、删除、目录路径展示;
- 设置页「会话文件上传」:启用开关、dock 显示开关、单文件上限说明;
- 服务端路由 `/dsh-session-files/*`:`upload` / `list` / `file` / `remove` / `config`;
- 安全:sessionId 白名单、文件名净化、目录锁定下载、单文件 512 MiB 上限、流式解析 + rename 原子落盘;
- 卸载(`plugin remove`)不影响已上传文件。