# dsh-session-files 集成测试

`test-host.mjs` 用 stub ctx(fake agents registry + webServer 捕获)+ 真实 `node:http`
服务器跑插件 host half(源码 `../lib/index.js`),覆盖:

- 上传落盘(含 UTF-8 内容、二进制、unicode 文件名、filename*、逐字节分块传输)
- 文件先于 sessionId 字段到达 → 拒绝;query/字段 sessionId 不一致 → 拒绝
- 目录穿越与非法文件名(路径分隔符、控制符、隐藏文件、`.`/`..`)
- list / download(内联与附件 disposition)/ remove / config / 404 / 大小上限 413
- 临时文件清理(超限后无 .part 残留)
- agent.inject 引导消息(上传后)与 agent/session-start 钩子(目录存在才注入)
- share_session_file 工具(执行边界:越界/缺失/目录/超限/跨会话;输出渲染)
- path 下载端点与 /share-info 元信息端点

## 运行

依赖 @deepseek-ai/{cordis,dsh-llm,dsh-timeout,schemastery,dsh-tools} 可解析。
典型做法:把这些包软链到本仓库(或 test/)的 `node_modules/@deepseek-ai/` 下,
路径取你本机 dsh CLI 安装处(通常 `node -p "require.resolve('@deepseek-ai/dsh/package.json')"`
的上一级目录):

```bash
mkdir -p node_modules/@deepseek-ai
# 找到本机 dsh 的 @deepseek-ai 包目录(替换 DSH_NODE_MODULES 为实际路径),
# 例如 DSH_NODE_MODULES=<dsh安装根>/node_modules/@deepseek-ai
DSH_NODE_MODULES="$(dirname "$(node -p "require.resolve('@deepseek-ai/dsh/package.json')" 2>/dev/null)")"
for p in cordis dsh-llm dsh-timeout schemastery dsh-tools; do
  ln -sfn "$DSH_NODE_MODULES/$p" "node_modules/@deepseek-ai/$p"
done
node test/test-host.mjs   # 或:cd test && node test-host.mjs
```

期望:`passed: 87  failed: 0`。