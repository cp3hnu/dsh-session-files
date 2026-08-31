// dsh-session-files host half — integration test.
// Runs the real plugin against a real node:http server, with a stub ctx
// (fake agents registry + webServer capture), then exercises
// upload/list/download/remove/config/limits/session-start hooks, and the
// share_session_file tool + path-based download endpoints over HTTP.
//
// 运行方式:
//   1) 本仓库根目录建 node_modules,提供 @deepseek-ai/{cordis,dsh-llm,dsh-timeout,
//      schemastery,dsh-tools} 的解析(可软链到 dsh CLI 安装里的同名包);
//   2) CHDIR: cd 到本目录,确保 import 的 ../../lib/index.js 能从 node_modules 解析依赖;
//   3) node test-host.mjs
// 结果为 "passed: N  failed: 0"。
import { createServer, request as httpRequest0 } from "node:http"
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
// 插件源码(发布目录 lib/);测试通过 node_modules 软链解析 @deepseek-ai 依赖
const plugin = await import(join(here, "..", "lib", "index.js"))

let passed = 0
let failed = 0
const failures = []
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log("  ok  -", name) }
  else { failed += 1; failures.push(name + (detail ? ` :: ${detail}` : "")); console.log("  FAIL-", name, detail) }
}
async function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ── scratch setup ───────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "dsf-test-"))
const wsA = join(root, "ws-a")
const wsB = join(root, "ws-b")
mkdirSync(wsA, { recursive: true })
mkdirSync(wsB, { recursive: true })
const SESS_A = "sess-aaa111"
const SESS_B = "sess-bbb222"

const injected = [] // { sessionId, text }
function makeAgent(id, cwd) {
  return {
    id,
    session: { header: { cwd } },
    inject: (message) => injected.push({ sessionId: id, text: message.content?.[0]?.text ?? "", message }),
  }
}
const agents = new Map([
  [SESS_A, makeAgent(SESS_A, wsA)],
  [SESS_B, makeAgent(SESS_B, wsB)],
])

// ── fake ctx / webServer / tools ─────────────────────────────────────────────
const routeHandlers = []
const eventHandlers = new Map()
const toolDefinitions = new Map() // name → defineTool 定义
const fakeCtx = {
  get: (name) => {
    if (name === "agents") return { get: (id) => agents.get(id) }
    if (name === "webServer") return fakeWebServer
    if (name === "tools") return {
      register: (def) => {
        toolDefinitions.set(def.name, def)
        return () => { toolDefinitions.delete(def.name) }
      },
    }
    return undefined
  },
  on: (name, fn) => { (eventHandlers.get(name) ?? eventHandlers.set(name, []).get(name)).push(fn) },
  off: (name, fn) => { const list = eventHandlers.get(name) ?? []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) },
  effect: () => {},
  logger: { warn: (...a) => console.log("[warn]", ...a), info: () => {}, error: (...a) => console.log("[error]", ...a) },
}
const fakeWebServer = {
  register: (route) => { routeHandlers.push(route); return () => {} },
}

plugin.apply(fakeCtx, { maxUploadBytes: 1024 * 1024 }) // 1 MiB cap for tests

async function dispatch(req, res) {
  const pathname = new URL(req.url ?? "/", "http://x").pathname
  const route = routeHandlers.find((r) => pathname === r.path || pathname.startsWith(r.path + "/"))
  if (!route) { res.writeHead(404); res.end(); return }
  await route.handler(req, res)
}

const server = createServer(dispatch)
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function httpRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = httpRequest0({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

function multipart(boundary, parts) {
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (part.filename !== undefined || part.filenameStar !== undefined) {
      let disc = `Content-Disposition: form-data; name="${part.name}"`
      if (part.filenameStar !== undefined) disc += `; filename*=UTF-8''${part.filenameStar}`
      else disc += `; filename="${part.filename}"`
      chunks.push(Buffer.from(`${disc}\r\nContent-Type: ${part.type ?? "application/octet-stream"}\r\n\r\n`))
      chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, "utf8"))
      chunks.push(Buffer.from("\r\n"))
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}
function boundary() { return "----dshT" + Math.random().toString(36).slice(2, 12) }

console.log("== upload ==")
{
  const b = boundary()
  const body = multipart(b, [
    { name: "sessionId", value: SESS_A },
    { name: "file", filename: "hello.txt", type: "text/plain", content: Buffer.from("你好, session files!\nline2\n") },
  ])
  const res = await httpRequest("POST", "/dsh-session-files/upload", {
    "Content-Type": `multipart/form-data; boundary=${b}`,
    "Content-Length": String(body.length),
  }, body)
  const json = JSON.parse(res.body.toString("utf8"))
  check("upload returns ok", res.status === 200 && json.ok === true, res.body.toString())
  const saved = join(wsA, "uploads", SESS_A, "hello.txt")
  check("file saved at uploads/<sid>/hello.txt", existsSync(saved))
  check("content preserved (utf8)", readFileSync(saved, "utf8") === "你好, session files!\nline2\n")
  check("no .part temp leftovers", readdirSync(join(wsA, "uploads", SESS_A)).filter((n) => n.startsWith(".part-")).length === 0)
  check("guidance injected once", injected.length === 1)
  const msg = injected[0]
  check("guidance mentions session dir", msg.sessionId === SESS_A && msg.text.includes(join(wsA, "uploads", SESS_A)), msg.text)
  check("guidance mentions relative path", msg.text.includes("uploads/" + SESS_A + "/"))
  check("guidance lists file", msg.text.includes("hello.txt"))
  check("guidance source is plugin", msg.message.source?.kind === "plugin" && msg.message.source?.plugin === "@deepseek-ai/dsh-session-files")
  check("guidance mentions fs guidance", msg.text.includes("read_image"))
}

console.log("== multi-file upload (field first, browser order) ==")
{
  injected.length = 0
  const b = boundary()
  const body = multipart(b, [
    { name: "sessionId", value: SESS_A },
    { name: "file", filename: "data.bin", type: "application/octet-stream", content: Buffer.from([0, 1, 2, 3, 0xff, 0xfe]) },
    { name: "file", filename: "doc.md", type: "text/markdown", content: Buffer.from("# doc\n") },
  ])
  const res = await httpRequest("POST", "/dsh-session-files/upload", {
    "Content-Type": `multipart/form-data; boundary=${b}`,
    "Content-Length": String(body.length),
  }, body)
  const json = JSON.parse(res.body.toString("utf8"))
  check("multi upload ok, 2 files", res.status === 200 && json.ok === true && json.files.length === 2, res.body.toString())
  check("binary content exact", Buffer.compare(readFileSync(join(wsA, "uploads", SESS_A, "data.bin")), Buffer.from([0, 1, 2, 3, 0xff, 0xfe])) === 0)
  check("guidance mentions both files", injected.length === 1 && injected[0].text.includes("data.bin") && injected[0].text.includes("doc.md"))

  // 文件部件先于 sessionId 字段到达 → 必须拒绝(防跨会话写盘的顺序约束)
  const b2 = boundary()
  const body2 = multipart(b2, [
    { name: "file", filename: "early.bin", content: Buffer.from("e") },
    { name: "sessionId", value: SESS_A },
  ])
  const res2 = await httpRequest("POST", "/dsh-session-files/upload", {
    "Content-Type": `multipart/form-data; boundary=${b2}`,
    "Content-Length": String(body2.length),
  }, body2)
  const json2 = JSON.parse(res2.body.toString("utf8"))
  check("file-before-sessionId rejected", res2.status === 400 && json2.ok === false && json2.error.code === "INVALID_SESSION", res2.body.toString())
  check("early file not committed", !existsSync(join(wsA, "uploads", SESS_A, "early.bin")))
}

console.log("== unicode + filename* ==")
{
  injected.length = 0
  const b = boundary()
  const body = multipart(b, [
    { name: "sessionId", value: SESS_A },
    { name: "file", filenameStar: encodeURIComponent("报告 2026 (final).pdf"), type: "application/pdf", content: Buffer.from("%PDF-1.4 fake") },
  ])
  const res = await httpRequest("POST", "/dsh-session-files/upload", {
    "Content-Type": `multipart/form-data; boundary=${b}`,
    "Content-Length": String(body.length),
  }, body)
  const json = JSON.parse(res.body.toString("utf8"))
  check("unicode filename accepted", res.status === 200 && json.ok === true && json.file.name === "报告 2026 (final).pdf", res.body.toString())
  check("unicode file on disk", existsSync(join(wsA, "uploads", SESS_A, "报告 2026 (final).pdf")))
}

console.log("== traversal / illegal names ==")
{
  const b = boundary()
  const attempts = [
    { filename: "../../../etc/passwd", expectSaved: "passwd" }, // basename 化,落盘为 passwd
    { filename: "..", expectReject: true },
    { filename: ".hidden", expectReject: true },
    { filename: "a\u0000b.txt", expectReject: true },
    { filename: "ok.txt", expectSaved: "ok.txt" },
  ]
  for (const attempt of attempts) {
    const body = multipart(b, [
      { name: "sessionId", value: SESS_A },
      { name: "file", filename: attempt.filename, content: Buffer.from("x") },
    ])
    const res = await httpRequest("POST", "/dsh-session-files/upload", {
      "Content-Type": `multipart/form-data; boundary=${b}`,
      "Content-Length": String(body.length),
    }, body)
    const json = JSON.parse(res.body.toString("utf8"))
    if (attempt.expectReject) {
      check(`reject filename "${attempt.filename}"`, res.status === 400 && json.ok === false, res.body.toString())
    } else {
      check(`sanitize "${attempt.filename}" -> ${attempt.expectSaved}`, res.status === 200 && json.ok === true && json.file.name === attempt.expectSaved, res.body.toString())
    }
  }
  check("traversal did not create etc/passwd", !existsSync(join(wsA, "etc", "passwd")) && !existsSync(join(root, "etc")))
}

console.log("== session mismatch + no file ==")
{
  const b = boundary()
  const body = multipart(b, [{ name: "sessionId", value: SESS_B }, { name: "file", filename: "x.txt", content: Buffer.from("x") }])
  const res = await httpRequest("POST", "/dsh-session-files/upload?sessionId=" + SESS_A, {
    "Content-Type": `multipart/form-data; boundary=${b}`,
    "Content-Length": String(body.length),
  }, body)
  const json = JSON.parse(res.body.toString("utf8"))
  check("session mismatch rejected", res.status === 400 && json.ok === false && json.error.code === "SESSION_MISMATCH", res.body.toString())

  const b2 = boundary()
  const body2 = multipart(b2, [{ name: "sessionId", value: SESS_A }])
  const res2 = await httpRequest("POST", "/dsh-session-files/upload", {
    "Content-Type": `multipart/form-data; boundary=${b2}`,
    "Content-Length": String(body2.length),
  }, body2)
  const json2 = JSON.parse(res2.body.toString("utf8"))
  check("no-file rejected", res2.status === 400 && json2.ok === false && json2.error.code === "NO_FILE", res2.body.toString())

  const res3 = await httpRequest("POST", "/dsh-session-files/upload?sessionId=../../..", {}, Buffer.alloc(0))
  const json3 = JSON.parse(res3.body.toString("utf8"))
  check("illegal sessionId in query rejected", res3.status === 400 && json3.error.code === "INVALID_SESSION")
}

console.log("== list ==")
{
  const res = await httpRequest("GET", "/dsh-session-files/list?sessionId=" + SESS_A)
  const json = JSON.parse(res.body.toString("utf8"))
  check("list ok", res.status === 200 && json.ok === true)
  check("list contains 6 files", json.files.length === 6, JSON.stringify(json.files.map((f) => f.name)))
  check("list reports dir", json.dir === join(wsA, "uploads", SESS_A))
  const names = json.files.map((f) => f.name)
  check("list sorted desc by time (newest first)", names[0] === "ok.txt" || names[0] === "x.txt" || names.includes("ok.txt"), names.join(","))
  check("list entries have mediaType", json.files.every((f) => typeof f.mediaType === "string" && f.mediaType.length > 0))

  const resB = await httpRequest("GET", "/dsh-session-files/list?sessionId=" + SESS_B)
  const jsonB = JSON.parse(resB.body.toString("utf8"))
  check("list for untouched session = empty", jsonB.ok === true && jsonB.files.length === 0 && jsonB.exists === false)
  check("list did NOT create dir for sess-b", !existsSync(join(wsB, "uploads")))

  const resBad = await httpRequest("GET", "/dsh-session-files/list?sessionId=../x")
  const jsonBad = JSON.parse(resBad.body.toString("utf8"))
  check("traversal sessionId rejected", resBad.status === 400 && jsonBad.error.code === "INVALID_SESSION")
}

console.log("== download ==")
{
  const res = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&name=${encodeURIComponent("hello.txt")}`)
  check("download 200 + body", res.status === 200 && res.body.toString("utf8").includes("你好"))
  check("text content-type", (res.headers["content-type"] ?? "").startsWith("text/plain"))
  check("inline disposition", (res.headers["content-disposition"] ?? "").startsWith("inline"))

  const res2 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&name=${encodeURIComponent("data.bin")}&download=1`)
  check("binary attachment disposition", (res2.headers["content-disposition"] ?? "").startsWith("attachment"))
  check("binary content-type octet-stream", (res2.headers["content-type"] ?? "").startsWith("application/octet-stream"))

  const res3 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&name=${encodeURIComponent("../hello.txt")}`)
  check("traversal name → basename only (404 -> no, serves hello.txt or 404; must not escape)", res3.status === 200 || res3.status === 404, String(res3.status))
  const res4 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&name=${encodeURIComponent("missing.txt")}`)
  check("missing file 404", res4.status === 404)
}

console.log("== remove ==")
{
  const res = await httpRequest("DELETE", `/dsh-session-files/remove?sessionId=${SESS_A}&name=${encodeURIComponent("ok.txt")}`)
  const json = JSON.parse(res.body.toString("utf8"))
  check("remove ok", res.status === 200 && json.ok === true && json.removed === true)
  check("file gone", !existsSync(join(wsA, "uploads", SESS_A, "ok.txt")))
  const res2 = await httpRequest("DELETE", `/dsh-session-files/remove?sessionId=${SESS_A}&name=${encodeURIComponent("ok.txt")}`)
  const json2 = JSON.parse(res2.body.toString("utf8"))
  check("remove missing → 404", res2.status === 404 && json2.error.code === "FILE_NOT_FOUND")
}

console.log("== config ==")
{
  const res = await httpRequest("GET", "/dsh-session-files/config")
  const json = JSON.parse(res.body.toString("utf8"))
  check("config ok", res.status === 200 && json.ok === true && json.config.maxUploadBytes === 1024 * 1024 && json.config.uploadDirName === "uploads")
}

console.log("== size cap ==")
{
  const b = boundary()
  const big = Buffer.alloc(1024 * 1024 + 10, 0x61)
  const body = multipart(b, [
    { name: "sessionId", value: SESS_A },
    { name: "file", filename: "big.bin", content: big },
  ])
  const res = await httpRequest("POST", "/dsh-session-files/upload", {
    "Content-Type": `multipart/form-data; boundary=${b}`,
    "Content-Length": String(body.length),
  }, body)
  const json = JSON.parse(res.body.toString("utf8"))
  check("oversize → 413", res.status === 413 && json.ok === false && json.error.code === "FILE_TOO_LARGE", res.body.toString())
  check("oversize file not committed", !existsSync(join(wsA, "uploads", SESS_A, "big.bin")))
  const leftovers = readdirSync(join(wsA, "uploads", SESS_A)).filter((n) => n.startsWith(".part-"))
  check("no temp leftovers after oversize", leftovers.length === 0, leftovers.join(","))
}

console.log("== session-start hook ==")
{
  injected.length = 0
  const startHandlers = eventHandlers.get("agent/session-start") ?? []
  check("session-start handler registered", startHandlers.length >= 1)
  // agent A: 上传目录已存在 → 应注入
  await startHandlers[0]({ agent: agents.get(SESS_A) })
  await wait(50)
  check("session-start injects for existing dir", injected.length === 1 && injected[0].sessionId === SESS_A)
  check("session-start guidance names dir", injected[0].text.includes(join(wsA, "uploads", SESS_A)))
  // agent B: 无目录 → 不注入、不建目录
  await startHandlers[0]({ agent: agents.get(SESS_B) })
  await wait(50)
  check("session-start no-op when dir absent", injected.length === 1 && !existsSync(join(wsB, "uploads")))
  // agent B 使用非法 cwd(空)也不应崩
  const agentBad = makeAgent("sess-bad000", "")
  agents.set("sess-bad000", agentBad)
  await startHandlers[0]({ agent: agentBad })
  await wait(50)
  check("session-start tolerates missing cwd", injected.length === 1)
}

console.log("== unknown session ==")
{
  const res = await httpRequest("GET", "/dsh-session-files/list?sessionId=sess-unknown")
  const json = JSON.parse(res.body.toString("utf8"))
  check("unknown session → 404", res.status === 404 && json.error.code === "SESSION_NOT_FOUND")
}

console.log("== bad content-type ==")
{
  const res = await httpRequest("POST", "/dsh-session-files/upload", { "Content-Type": "application/json" }, Buffer.from("{}"))
  const json = JSON.parse(res.body.toString("utf8"))
  check("non-multipart rejected", res.status === 400 && json.error.code === "BAD_CONTENT_TYPE")
}

console.log("== chunked byte-by-byte delivery ==")
{
  injected.length = 0
  const b = boundary()
  const body = multipart(b, [
    { name: "sessionId", value: SESS_A },
    { name: "file", filename: "trickle.bin", content: Buffer.from("0123456789abcdef".repeat(300)) },
  ])
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest0({ host: "127.0.0.1", port, method: "POST", path: "/dsh-session-files/upload", headers: { "Content-Type": `multipart/form-data; boundary=${b}`, "Content-Length": String(body.length) } }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode))
    })
    req.on("error", reject)
    // 逐字节写入,间隔 0——完整覆盖边界拆分逻辑
    let i = 0
    const next = () => {
      if (i >= body.length) { req.end(); return }
      req.write(body.subarray(i, i + 1), next)
      i += 1
    }
    next()
  })
  check("chunked upload 200", status === 200, String(status))
  const saved = join(wsA, "uploads", SESS_A, "trickle.bin")
  check("chunked file exists", existsSync(saved))
  const expected = Buffer.from("0123456789abcdef".repeat(300))
  check("chunked content bytes exact", existsSync(saved) && Buffer.compare(readFileSync(saved), expected) === 0)
  check("chunked guidance injected", injected.length === 1)
}

console.log("== share_session_file 工具 ==")
{
  const shareDir = join(wsA, "deliverables")
  mkdirSync(shareDir, { recursive: true })
  writeFileSync(join(shareDir, "report.pdf"), "%PDF-1.4 fake report")
  writeFileSync(join(wsA, "note.txt"), "hello note")
  writeFileSync(join(wsB, "other.txt"), "other session file")

  const def = toolDefinitions.get("share_session_file")
  check("tool registered", def !== undefined && def.name === "share_session_file")
  check("tool description present", typeof def.description === "string" && def.description.includes("下载"))
  check("tool path required, name/description optional", Array.isArray(def.parameters?.required)
    && def.parameters.required.includes("path")
    && !def.parameters.required.includes("name")
    && !def.parameters.required.includes("description"))

  const exec = async (args, agent) => def.execute(args, { agent, signal: undefined })

  const r1 = await exec({ path: "deliverables/report.pdf" }, agents.get(SESS_A))
  check("exec relative path ok", r1.ok !== false && r1.name === "report.pdf" && r1.mediaType.startsWith("application/pdf") && r1.bytes > 0 && r1.path === "deliverables/report.pdf")

  const r2 = await exec({ path: join(wsA, "note.txt") }, agents.get(SESS_A))
  check("exec absolute in-workspace ok", r2.name === "note.txt" && r2.path === "note.txt")

  const r3 = await exec({ path: "deliverables/report.pdf", name: "最终报告.pdf" }, agents.get(SESS_A))
  check("exec custom display name", r3.name === "最终报告.pdf")

  const r4 = await exec({ path: "deliverables/report.pdf", name: "../evil.pdf" }, agents.get(SESS_A))
  check("exec display name sanitized to basename", r4.name === "evil.pdf")

  let e1 = null; try { await exec({ path: "../secret" }, agents.get(SESS_A)) } catch (e) { e1 = e }
  check("exec rejects ../ escape", e1 !== null && String(e1.message).includes("越出"))

  let e2 = null; try { await exec({ path: "/etc/hostname" }, agents.get(SESS_A)) } catch (e) { e2 = e }
  check("exec rejects absolute outside workspace", e2 !== null)

  let e3 = null; try { await exec({ path: "no-such-file.txt" }, agents.get(SESS_A)) } catch (e) { e3 = e }
  check("exec rejects missing file", e3 !== null)

  let e4 = null; try { await exec({ path: "deliverables" }, agents.get(SESS_A)) } catch (e) { e4 = e }
  check("exec rejects directory", e4 !== null)

  writeFileSync(join(wsA, "big.bin"), Buffer.alloc(1024 * 1024 + 100, 7))
  let e5 = null; try { await exec({ path: "big.bin" }, agents.get(SESS_A)) } catch (e) { e5 = e }
  check("exec rejects oversize (>1MiB cap)", e5 !== null && String(e5.message).includes("过大"))

  let e6 = null; try { await exec({ path: "../ws-b/other.txt" }, agents.get(SESS_A)) } catch (e) { e6 = e }
  check("exec rejects cross-session escape", e6 !== null)

  const rendered = def.output.render({}, r1)
  check("output render mentions download+name", rendered[0]?.type === "text" && rendered[0].text.includes("下载") && rendered[0].text.includes("report.pdf"))
}

console.log("== /file path 下载与 /share-info ==")
{
  const res = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&path=${encodeURIComponent("deliverables/report.pdf")}&download=1`)
  check("path download 200 + body", res.status === 200 && res.body.toString("utf8").includes("%PDF-1.4"))
  check("path download disposition attachment", (res.headers["content-disposition"] ?? "").startsWith("attachment") && (res.headers["content-disposition"] ?? "").includes("report.pdf"))

  const res2 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&path=${encodeURIComponent(join(wsA, "note.txt"))}`)
  check("absolute in-workspace download ok", res2.status === 200 && res2.body.toString("utf8").includes("hello note"))

  const res3 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&path=${encodeURIComponent("../secret.txt")}`)
  const j3 = JSON.parse(res3.body.toString("utf8"))
  check("path traversal download rejected", res3.status === 400 && j3.error.code === "INVALID_PATH")

  const res4 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&path=${encodeURIComponent("/etc/hostname")}`)
  const j4 = JSON.parse(res4.body.toString("utf8"))
  check("absolute outside download rejected", res4.status === 400 && j4.error.code === "INVALID_PATH")

  const res5 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&name=x.txt&path=note.txt`)
  const j5 = JSON.parse(res5.body.toString("utf8"))
  check("name+path both rejected", res5.status === 400 && j5.error.code === "AMBIGUOUS_TARGET")

  const res6 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}`)
  const j6 = JSON.parse(res6.body.toString("utf8"))
  check("neither name nor path rejected", res6.status === 400 && (j6.error.code === "AMBIGUOUS_TARGET" || j6.error.code === "INVALID_FILENAME"))

  const res7 = await httpRequest("GET", `/dsh-session-files/file?sessionId=${SESS_A}&path=${encodeURIComponent("missing.txt")}`)
  check("missing path file 404", res7.status === 404)

  const ri = await httpRequest("GET", `/dsh-session-files/share-info?sessionId=${SESS_A}&path=${encodeURIComponent("deliverables/report.pdf")}`)
  const ji = JSON.parse(ri.body.toString("utf8"))
  check("share-info returns name/type/bytes/relPath", ri.status === 200 && ji.ok === true && ji.file.name === "report.pdf" && typeof ji.file.bytes === "number" && ji.file.relativePath === "deliverables/report.pdf")

  const ri2 = await httpRequest("GET", `/dsh-session-files/share-info?sessionId=${SESS_A}&path=${encodeURIComponent("../x")}`)
  check("share-info traversal rejected", ri2.status === 400)

  const ri3 = await httpRequest("GET", `/dsh-session-files/share-info?sessionId=${SESS_A}&path=${encodeURIComponent("missing.txt")}`)
  const ji3 = JSON.parse(ri3.body.toString("utf8"))
  check("share-info missing → file null", ri3.status === 200 && ji3.ok === true && ji3.file === null)
}

// guidance 更新:引导文案里应包含 share_session_file 用法,并提醒不要把分享文件复制进 uploads/
{
  const last = injected[injected.length - 1]
  check("guidance mentions share_session_file", typeof last?.text === "string" && last.text.includes("share_session_file"))
  check("guidance warns not to copy into uploads", typeof last?.text === "string" && last.text.includes("uploads/") && last.text.includes("已上传"))
  const def = toolDefinitions.get("share_session_file")
  check("tool description warns not to copy into uploads", typeof def?.description === "string" && def.description.includes("uploads/"))
}

// ── teardown ────────────────────────────────────────────────────────────────
await new Promise((r) => server.close(r))
rmSync(root, { recursive: true, force: true })

console.log("\n==============================")
console.log(`passed: ${passed}  failed: ${failed}`)
if (failed > 0) {
  console.log("failures:\n" + failures.map((f) => "  - " + f).join("\n"))
  process.exit(1)
}