# dsh-session-files v0.2.2

## 界面:emoji 拟物图标 → DSH 官方图标库

客户端改用 `@deepseek-ai/dsh-client-ui-primitives` 的官方图标组件,
与 shell 外观一致(`currentColor` 随主题着色):

- 上传按钮:📎 emoji → `IconPaperclipOutline16`
- 「已上传」dock 标题:📎 emoji → `IconPaperclipOutline16`(14px)
- 文件芯片删除:文本 × → `IconCloseOutline16`(12px)
- 分享下载卡片类型图标(按类型映射):
  - PDF/文档/Markdown/文本/JSON/YAML/XML/网页 → `IconListPenOutline16`
  - 图片 → `IconBrowseOutline16`
  - 压缩包 → `IconArchiveOutline20`
  - 音频/视频 → `IconPlayOutline16`
  - 表格 → `IconDataOutline16`
  - Python/JS/TS/Shell → `IconCodeOutline16`
  - 其它 → `IconPaperclipOutline16`
- 「下载」按钮:新增 `IconDownloadOutline16`(14px)+ 文字

## 验证

- `node --check` 通过;集成测试 87/87 不受影响(纯客户端渲染改动)。
- 客户端模块直接 `require("@deepseek-ai/dsh-client-ui-primitives")`,
  该共享模块已在 boot 图中,无需新增 `dsh.client.inject` 声明。