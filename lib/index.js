/**
 * dsh-session-files — Host half (v0.2.0)
 *
 * 让用户在会话中上传「任意文件」(不限于模型原生接受的图片),并把文件落到
 * 会话工作区内的专用目录:
 *
 *   <session.workspace>/uploads/<sessionId>/<文件>
 *
 * 其中 <session.workspace> 是本会话的 cwd(`agent.session.header.cwd`);
 * `uploads/` 是专门存放此类内容的目录;`<sessionId>/` 是对应该 session 的子目录。
 * 只有用户真正上传文件时才创建目录(服务端不在其它时机建目录)。
 *
 * 上传成功后,插件向该会话的 agent 注入一条 user 消息(agent.inject),把
 * 「本会话的上传目录」与已上传文件清单告知模型;会话启动/恢复时若该目录已
 * 存在(上次上传过),也会注入一条同等性质的消息,保证模型始终知道哪一个目录
 * 对应本 session。
 *
 * v0.2.0 新增「模型提供文件下载」:注册模型工具 share_session_file,模型在
 * 对话中把工作区内的文件(处理结果等)提供给用户;客户端在对话流里渲染
 * 可点击的文件卡片。下载端点 /file 支持 path 参数(相对会话工作区的任意
 * 文件,严格防越界),另提供 /share-info 供卡片展示名称/类型/大小。
 *
 * 路由(前缀 /dsh-session-files):
 *   POST   /upload    multipart/form-data;字段 sessionId + 若干 file part
 *   GET    /list?sessionId=..         列出该会话已上传文件(目录不存在返回空列表)
 *   GET    /file?sessionId=..&name=.. 下载/查看已上传文件(download=1 强制下载)
 *   GET    /file?sessionId=..&path=.. 下载/查看工作区内任意文件(防越界)
 *   GET    /share-info?sessionId=..&path=.. 文件元信息(名称/类型/大小)
 *   DELETE /remove?sessionId=..&name=.. 删除单个文件
 *   GET    /config                    服务端配置(上传大小上限等)
 *
 * 安全约束:sessionId 与文件名都做严格校验(防目录穿越);path 必须解析到
 * 会话 cwd 之内;单文件大小上限 maxUploadBytes(默认 512 MiB)。
 *
 * License: MIT
 */
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs"
import { mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import z from "@deepseek-ai/schemastery"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { defineTool } from "@deepseek-ai/dsh-tools"

/** 插件标识(也是注入消息的 source.plugin)。 */
const PLUGIN = "@deepseek-ai/dsh-session-files"

/** 模型「提供文件下载」工具名(客户端 toolview 按此 key 渲染卡片)。 */
const SHARE_TOOL_NAME = "share_session_file"

/** 路由前缀。 */
const ROUTE_PREFIX = "/dsh-session-files"

/** workspace 内专门存放此类内容的目录名。 */
const UPLOAD_DIR_NAME = "uploads"

/** 默认单文件大小上限。 */
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/** 字段(field part)大小上限。 */
const MAX_FIELD_BYTES = 4 * 1024

/** multipart 部件头区大小上限。 */
const MAX_HEADER_BYTES = 16 * 1024

/** boundary 长度上限(防超长 delimiter 拖慢搜索)。 */
const MAX_BOUNDARY_LENGTH = 200

/** 扩展名 → Content-Type(用于 GET /file)。 */
const EXT_MEDIA_TYPES = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".log": "text/plain; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".xz": "application/x-xz",
  ".bz2": "application/x-bzip2",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

/** 内联展示的安全类型集合(其余默认附件下载)。 */
const INLINE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yml", ".yaml", ".csv", ".tsv", ".xml",
  ".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".svg",
  ".log", ".py", ".sh", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".pdf",
])

/** 校验后的插件配置。 */
const Config = z.object({
  maxUploadBytes: z.natural().default(DEFAULT_MAX_UPLOAD_BYTES),
})

/** 会话 id 白名单(防目录穿越)。 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,80}$/

/** 文件名黑名单字符:控制符、路径分隔符。 */
const FORBIDDEN_FILE_CHARS = /[\u0000-\u001f\u007f/\\]/

//#region 工具函数

/** sessionId 校验:通过返回原值,否则返回 null。 */
function sanitizeSessionId(raw) {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  return SESSION_ID_RE.test(value) ? value : null
}

/** 文件名净化:只取叶子名,拒绝空名/点目录/控制符/分隔符/超长。返回 null 表示非法。 */
function sanitizeFileName(raw) {
  if (typeof raw !== "string") return null
  let name = raw
  // 去掉任何路径前缀(跨平台:同时处理 / 与 \)
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))
  if (slash >= 0) name = name.slice(slash + 1)
  // 去掉首尾空白与 Windows 顽固尾部点
  name = name.trim().replace(/[. ]+$/u, "")
  if (name.length === 0 || name === "." || name === "..") return null
  if (name.startsWith(".")) return null // 隐藏文件一律拒绝
  if (FORBIDDEN_FILE_CHARS.test(name)) return null
  if (Buffer.byteLength(name, "utf8") > 200) return null
  return name
}

/** 解析 multipart 的 Content-Type 头,取出 boundary;非法返回 null。 */
function boundaryOf(contentType) {
  if (typeof contentType !== "string") return null
  if (!/^multipart\/form-data\b/i.test(contentType.trim())) return null
  const match = /(?:^|;\s*)boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType.trim())
  const boundary = match ? (match[1] ?? match[2]) : null
  if (boundary === null || boundary.length === 0 || boundary.length > MAX_BOUNDARY_LENGTH) return null
  return boundary
}

/** 从部件头文本解析 Content-Disposition 的 name / filename(+RFC 5987 filename*)。 */
function parseDisposition(headerText) {
  const result = { name: null, filename: null }
  const disposition = headerText.split("\r\n").find((line) => /^content-disposition:/i.test(line))
  if (disposition === undefined) return result
  const nameMatch = /;\s*name="([^"]*)"/i.exec(disposition)
  if (nameMatch !== null) result.name = nameMatch[1]
  // filename*: RFC 5987,UTF-8''percent-encoded
  const starMatch = /;\s*filename\*=(?:UTF-8|utf-8)''([^;]*)/i.exec(disposition)
  if (starMatch !== null) {
    try {
      result.filename = decodeURIComponent(starMatch[1])
      return result
    } catch {
      /* 落到普通 filename */
    }
  }
  const plainMatch = /;\s*filename="([^"]*)"/i.exec(disposition)
  if (plainMatch !== null) {
    // node:http 把原始字节按 latin1 解码;发送方若写的是 UTF-8 原始字节,这里还原
    result.filename = Buffer.from(plainMatch[1], "latin1").toString("utf8")
  }
  return result
}

/** 文件扩展名 → Content-Type。 */
function mediaTypeOf(name) {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return "application/octet-stream"
  return EXT_MEDIA_TYPES[name.slice(dot).toLowerCase()] ?? "application/octet-stream"
}

function respondJson(res, status, value) {
  const data = Buffer.from(JSON.stringify(value), "utf8")
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Content-Length", String(data.length))
  res.setHeader("Cache-Control", "no-store")
  res.end(data)
}

function respondError(res, status, code, message) {
  respondJson(res, status, { ok: false, error: { code, message } })
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 当前插件配置(带默认值)。 */
function resolveConfig(raw) {
  const parsed = Config(raw ?? {})
  return { maxUploadBytes: parsed.maxUploadBytes }
}

//#endregion

//#region multipart 流式解析

/**
 * 流式解析 multipart/form-data 请求体。
 *
 * - field part:内存累积,上限 maxFieldBytes,回调 onField(name, value)
 * - file part:流式写盘,上限 maxFileBytes,回调 onFile 在部件结束时收到
 *   { name, mediaType, dir, tmpPath, finalName, bytes }
 * - 每个文件部件的落盘目录由 options.tmpDirFor() 决定(每次调用):
 *   返回 null 表示暂未确定(如 sessionId 字段尚未到达),解析将失败退出;
 *   onField 抛错(code 属性)会以该 code 失败。
 * - 任何超限/畸形都会 reject(带 code),调用方负责清理已写入的临时文件。
 */
function parseMultipart(req, options) {
  const { boundary, maxFieldBytes, maxFileBytes, onField, onFile } = options
  const delimiter = Buffer.from(`\r\n--${boundary}`, "utf8")
  const firstDelimiter = Buffer.from(`--${boundary}`, "utf8")
  const CRLFCRLF = Buffer.from("\r\n\r\n", "utf8")
  const CRLF = Buffer.from("\r\n", "utf8")
  const DOUBLE_DASH = Buffer.from("--", "utf8")

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let pos = 0
    let headerEnd = -1
    let state = "start" // start | headers | body | line-end | done
    let pendingField = null // { name, value }
    let pendingFile = null // { name, mediaType, finalName, tmpPath, stream, bytes }
    let doneResolved = false

    const failUpload = (code, message, cause) => {
      // 失败时清掉正在写入的临时文件(尚未提交给 onFile 的部分)。
      // 同步删除保证调用方在 reject 返回时盘上已无残留;删除失败再异步兜底。
      if (pendingFile !== null) {
        const stream = pendingFile.stream
        const tmpPath = pendingFile.tmpPath
        pendingFile = null
        try { stream.destroy() } catch { /* 忽略 */ }
        try {
          rmSync(tmpPath, { force: true, maxRetries: 3 })
        } catch {
          void rm(tmpPath, { force: true }).catch(() => {})
        }
      }
      const error = fail(code, message)
      if (cause !== undefined) error.cause = cause
      reject(error)
    }

    const finishField = () => {
      if (pendingField !== null) {
        try {
          onField(pendingField.name, pendingField.value)
        } catch (error) {
          if (typeof error?.code === "string") failUpload(error.code, error.message, error)
          else failUpload("UPLOAD_INTERNAL", "字段处理失败", error)
          return false
        }
        pendingField = null
      }
      return true
    }

    const startPart = () => {
      // 部件头已完整(在 buffer[pos] 之前)
      const headerText = buffer.toString("utf8", pos, headerEnd)
      pos = headerEnd + 4
      const disposition = parseDisposition(headerText)
      const isFilePart = disposition.filename !== null
      if (isFilePart) {
        const finalName = sanitizeFileName(disposition.filename)
        if (finalName === null) {
          failUpload("INVALID_FILENAME", `文件名非法: ${disposition.filename ?? ""}`)
          return false
        }
        const mediaTypeMatch = /^content-type:\s*(\S+)/im.exec(headerText)
        const tmpDir = typeof options.tmpDirFor === "function"
          ? options.tmpDirFor()
          : typeof options.tmpDir === "function"
            ? options.tmpDir()
            : options.tmpDir
        if (typeof tmpDir !== "string" || tmpDir.length === 0) {
          failUpload("INVALID_SESSION", "sessionId 字段缺失或未先于文件到达")
          return false
        }
        const tmpPath = join(tmpDir, `.part-${randomUUID()}`)
        let stream
        try {
          stream = createWriteStream(tmpPath, { flags: "wx", mode: 0o600 })
          stream.on("error", (error) => {
            failUpload("UPLOAD_IO_ERROR", "写入临时文件失败", error)
          })
        } catch (error) {
          failUpload("UPLOAD_INTERNAL", "无法创建临时文件", error)
          return false
        }
        pendingFile = {
          name: finalName,
          mediaType: mediaTypeMatch !== null ? mediaTypeMatch[1] : "application/octet-stream",
          finalName,
          tmpPath,
          stream,
          bytes: 0,
        }
      } else {
        pendingField = { name: disposition.name ?? "", value: "" }
      }
      state = "body"
      return true
    }

    const emitBody = (from, to) => {
      if (pendingFile !== null) {
        const chunk = buffer.subarray(from, to)
        pendingFile.bytes += chunk.length
        if (pendingFile.bytes > maxFileBytes) {
          failUpload("FILE_TOO_LARGE", `文件超过大小上限(${maxFileBytes} 字节)`)
          return false
        }
        if (!pendingFile.stream.write(chunk)) {
          // 背压:等待 drain 不阻塞解析流程——小文件场景极少触发,直接等待写入完成
          // (write 返回 false 仅表示缓冲,数据仍在内存,不会丢)
        }
      } else if (pendingField !== null) {
        const chunk = buffer.toString("utf8", from, to)
        pendingField.value += chunk
        if (Buffer.byteLength(pendingField.value, "utf8") > maxFieldBytes) {
          failUpload("FIELD_TOO_LARGE", `字段 ${pendingField.name} 超过大小上限`)
          return false
        }
      }
      return true
    }

    const endPart = () => {
      // 部件体结束:收尾当前部件
      if (pendingFile !== null) {
        const file = pendingFile
        pendingFile = null
        file.stream.end()
        // rename 在数据完整后由 onFile 回调完成——endPart 只负责通知调用方
        try {
          onFile({ ...file, bytes: file.bytes })
        } catch (error) {
          failUpload("UPLOAD_INTERNAL", "文件提交失败", error)
          return false
        }
      } else if (pendingField !== null) {
        if (!finishField()) return false
      }
      state = "line-end"
      return true
    }

    const process = () => {
      if (doneResolved) return
      for (;;) {
        if (state === "start") {
          // 寻找首个 boundary
          const index = buffer.indexOf(firstDelimiter, pos)
          if (index === -1) {
            // 前导内容(浏览器不产生)超过 4KiB 视为非法
            if (buffer.length - pos > MAX_HEADER_BYTES) {
              failUpload("BAD_MULTIPART", "multipart 缺少起始 boundary")
              return
            }
            return // 等更多数据
          }
          pos = index + firstDelimiter.length
          if (buffer.length - pos >= 2 && buffer.subarray(pos, pos + 2).equals(DOUBLE_DASH)) {
            resolve({}) // 空请求体
            doneResolved = true
            return
          }
          if (buffer.length - pos < 2) return
          if (buffer.subarray(pos, pos + 2).equals(CRLF)) {
            pos += 2
            state = "headers"
          } else {
            failUpload("BAD_MULTIPART", "起始 boundary 后缺少 CRLF")
            return
          }
        } else if (state === "headers") {
          const index = buffer.indexOf(CRLFCRLF, pos)
          if (index === -1) {
            if (buffer.length - pos > MAX_HEADER_BYTES) {
              failUpload("BAD_MULTIPART", "部件头超限")
              return
            }
            return
          }
          headerEnd = index
          if (!startPart()) return
        } else if (state === "body") {
          const index = buffer.indexOf(delimiter, pos)
          if (index === -1) {
            // 保留可能属于 delimiter 前缀的尾部字节
            const keep = delimiter.length - 1
            const flushable = buffer.length - pos - keep
            if (flushable > 0) {
              if (!emitBody(pos, pos + flushable)) return
              pos += flushable
            }
            return
          }
          if (!emitBody(pos, index)) return
          pos = index + delimiter.length
          if (!endPart()) return
        } else if (state === "line-end") {
          // delimiter 之后:"--\r\n" 结束,或 "\r\n" 进入下一部件
          if (buffer.length - pos < 2) return
          if (buffer.subarray(pos, pos + 2).equals(DOUBLE_DASH)) {
            pos += 2
            resolve({}) // 收尾数据(通常 "\r\n")不校验
            doneResolved = true
            return
          }
          if (buffer.subarray(pos, pos + 2).equals(CRLF)) {
            pos += 2
            state = "headers"
          } else {
            failUpload("BAD_MULTIPART", "boundary 行尾非法")
            return
          }
        } else {
          return
        }
      }
    }

    req.on("data", (chunk) => {
      if (doneResolved) return
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
      // 紧凑合并
      if (pos > 0) {
        buffer = Buffer.concat([buffer.subarray(pos), chunk])
        pos = 0
      } else {
        buffer = Buffer.concat([buffer, chunk])
      }
      process()
    })
    req.on("end", () => {
      if (doneResolved) return
      if (state !== "body" && state !== "headers" && state !== "start") {
        failUpload("BAD_MULTIPART", "请求体意外结束")
        return
      }
      // 最后一个部件体可能没有结尾 delimiter(浏览器总会发送;这里宽容处理)
      if (state === "body" && pendingFile !== null && buffer.length > pos) {
        if (!emitBody(pos, buffer.length)) return
        pos = buffer.length
      }
      if (pendingFile !== null) {
        // 无结尾 delimiter 的收尾
        if (!emitBody(pos, buffer.length)) return
        if (!endPart()) return
      } else if (pendingField !== null) {
        if (!finishField()) return
      }
      resolve({})
      doneResolved = true
    })
    req.on("error", (error) => {
      if (!doneResolved) failUpload("UPLOAD_IO_ERROR", "请求读取失败", error)
    })
  })
}

//#endregion

//#region 会话目录

/** 解析会话与目标目录;agent 不存在或没有 cwd 时返回 null。 */
function resolveUploadTarget(ctx, sessionId) {
  if (sessionId === null) return null
  const agents = ctx.get("agents")
  const agent = agents !== undefined && typeof agents.get === "function" ? agents.get(sessionId) : undefined
  if (agent === undefined) return null
  const cwd = agent.session?.header?.cwd
  if (typeof cwd !== "string" || cwd.length === 0) return null
  return { agent, cwd, dir: join(cwd, UPLOAD_DIR_NAME, sessionId) }
}

/** 上传目录在会话 cwd 内的相对路径。 */
function relativeUploadDir(sessionId) {
  return `${UPLOAD_DIR_NAME}/${sessionId}`
}

/** 上报文件的展示信息。 */
async function fileEntry(dir, name) {
  const info = await stat(join(dir, name))
  return {
    name,
    mediaType: mediaTypeOf(name),
    bytes: info.size,
    at: Math.round(info.mtimeMs),
  }
}

/** 注入给模型的引导文本(上传若干文件之后)。 */
function uploadGuidanceText(cwd, sessionId, entries) {
  const lines = [
    `用户通过界面上的「上传文件」把文件放入了本会话的专用上传目录(此目录专属于当前会话):`,
    `  ${join(cwd, UPLOAD_DIR_NAME, sessionId)}`,
    `(相对当前工作目录的固定路径:${relativeUploadDir(sessionId)}/)`,
    ``,
    `本次上传的文件:`,
  ]
  for (const entry of entries) {
    lines.push(`- ${entry.name}(${entry.bytes} 字节,${entry.mediaType})→ ${join(cwd, UPLOAD_DIR_NAME, sessionId, entry.name)}`)
  }
  lines.push(
    ``,
    `用户提到「上传的文件/附件」时,请先列出该目录(fs 工具,相对路径 ${relativeUploadDir(sessionId)}/),`,
    `再按需读取内容:文本用 read,图片用 read_image,其它二进制可用 bash 的 file/od/strings 等探查。`,
    ``,
    SHARE_HINT,
  )
  return lines.join("\n")
}

/** 注入给模型的引导文本(会话启动时目录已存在)。 */
function resumeGuidanceText(cwd, sessionId) {
  return [
    `本会话存在已上传的文件,存放于本会话专用上传目录:`,
    `  ${join(cwd, UPLOAD_DIR_NAME, sessionId)}`,
    `(相对当前工作目录的固定路径:${relativeUploadDir(sessionId)}/)`,
    ``,
    `用户提到「上传的文件/附件」时,请先列出该目录,再按需读取内容:`,
    `文本用 read,图片用 read_image,其它二进制可用 bash 的 file/od/strings 等探查。`,
    ``,
    SHARE_HINT,
  ].join("\n")
}

/** 「如何把文件提供给用户下载」的引导文案(追加在注入消息尾部)。 */
const SHARE_HINT = [
  `「把文件发给用户 / 提供下载」:调用 share_session_file 工具,提供工作区内文件的路径`,
  `(绝对路径或相对 cwd),用户即可在对话流中看到文件卡片并点击下载——处理好的结果文件`,
  `(报告、打包、图片、表格等)请用这个工具交给用户,而不是只告诉用户文件路径。`,
  `注意:分享时直接引用文件的原路径即可;不要把文件复制进 ${UPLOAD_DIR_NAME}/ 目录——`,
  `该目录只属于用户主动上传的文件,会显示在「已上传」列表里。`,
].join("")

/** 把用户提供的路径解析为会话工作区内的绝对路径;越界/非法返回 null。 */
function resolveWorkspacePath(cwd, raw) {
  if (typeof raw !== "string" || raw.length === 0) return null
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return null
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw)
  if (isAbsolute(absolute) === false) return null
  const rel = relative(cwd, absolute)
  if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) return null
  return absolute
}

//#endregion

//#region 路由处理

/**
 * 处理一个请求:按 method + pathname 路由。
 */
async function handleRequest(ctx, config, req, res) {
  const url = new URL(req.url ?? "/", "http://local")
  const pathname = url.pathname
  const method = req.method ?? "GET"

  if (method === "GET" && pathname === `${ROUTE_PREFIX}/config`) {
    respondJson(res, 200, {
      ok: true,
      config: {
        maxUploadBytes: config.maxUploadBytes,
        uploadDirName: UPLOAD_DIR_NAME,
      },
    })
    return
  }

  const sessionId = url.searchParams.get("sessionId")
  const cleanSessionId = sanitizeSessionId(sessionId)
  const isUpload = method === "POST" && pathname === `${ROUTE_PREFIX}/upload`

  // 上传接口的 sessionId 可以由 query 提供(推荐),也可以只出现在 multipart 字段里:
  // 两种都给时服务端会做一致性校验。因此上传允许 query 缺失,但若提供了必须合法。
  if (isUpload) {
    if (sessionId !== null && cleanSessionId === null) {
      respondError(res, 400, "INVALID_SESSION", "sessionId 缺失或非法")
      return
    }
    await handleUpload(ctx, config, cleanSessionId, req, res)
    return
  }

  if (cleanSessionId === null) {
    respondError(res, 400, "INVALID_SESSION", "sessionId 缺失或非法")
    return
  }
  const target = resolveUploadTarget(ctx, cleanSessionId)
  if (target === null) {
    respondError(res, 404, "SESSION_NOT_FOUND", "会话不存在或未加载")
    return
  }

  if (method === "GET" && pathname === `${ROUTE_PREFIX}/list`) {
    let names = []
    try {
      names = await readdir(target.dir)
    } catch (error) {
      if (error.code !== "ENOENT") {
        ctx.logger?.warn?.(`${PLUGIN}: list failed: ${error.message ?? error}`)
        respondError(res, 500, "LIST_FAILED", "目录读取失败")
        return
      }
      // 目录不存在:说明从未上传过,返回空列表(不创建目录)
    }
    const entries = []
    for (const name of names) {
      if (name.startsWith(".")) continue // 隐藏/临时文件不展示
      try {
        entries.push(await fileEntry(target.dir, name))
      } catch {
        /* 竞态删除:跳过 */
      }
    }
    entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name.localeCompare(b.name)))
    respondJson(res, 200, {
      ok: true,
      dir: target.dir,
      relativeDir: relativeUploadDir(cleanSessionId),
      exists: entries.length > 0,
      files: entries,
    })
    return
  }

  if (method === "GET" && pathname === `${ROUTE_PREFIX}/file`) {
    // 两种取址方式:name(已上传目录内)或 path(工作区内任意路径)互斥
    const nameParam = url.searchParams.get("name")
    const pathParam = url.searchParams.get("path")
    let path
    let downloadName
    if (nameParam !== null && pathParam === null) {
      const name = sanitizeFileName(nameParam)
      if (name === null) {
        respondError(res, 400, "INVALID_FILENAME", "文件名缺失或非法")
        return
      }
      path = join(target.dir, name)
      downloadName = name
    } else if (pathParam !== null && nameParam === null) {
      const resolved = resolveWorkspacePath(target.cwd, pathParam)
      if (resolved === null) {
        respondError(res, 400, "INVALID_PATH", "path 非法或越出会话工作区")
        return
      }
      path = resolved
      downloadName = sanitizeFileName(basename(resolved)) ?? "file"
    } else {
      respondError(res, 400, "AMBIGUOUS_TARGET", "name 与 path 必须且只能提供一个")
      return
    }
    let handle
    try {
      handle = await open(path, "r")
    } catch (error) {
      if (error.code === "ENOENT") {
        respondError(res, 404, "FILE_NOT_FOUND", "文件不存在")
        return
      }
      respondError(res, 500, "OPEN_FAILED", "文件打开失败")
      return
    }
    const info = await handle.stat().catch(() => null)
    await handle.close().catch(() => {})
    if (info === null || !info.isFile()) {
      respondError(res, 404, "FILE_NOT_FOUND", "文件不存在")
      return
    }
    const ext = downloadName.slice(downloadName.lastIndexOf(".")).toLowerCase()
    const mediaType = mediaTypeOf(downloadName)
    const download = url.searchParams.get("download") === "1"
    const disposition = download || !INLINE_EXTENSIONS.has(ext) ? "attachment" : "inline"
    res.statusCode = 200
    res.setHeader("Content-Type", mediaType)
    res.setHeader("Content-Length", String(info.size))
    res.setHeader("Content-Disposition", `${disposition}; filename="${asciiFallback(downloadName)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`)
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Cache-Control", "no-store")
    const stream = createReadStream(path)
    stream.on("error", () => {
      if (!res.headersSent) respondError(res, 500, "READ_FAILED", "文件读取失败")
      res.destroy()
    })
    stream.pipe(res)
    return
  }

  if (method === "GET" && pathname === `${ROUTE_PREFIX}/share-info`) {
    const pathParam = url.searchParams.get("path")
    const resolved = resolveWorkspacePath(target.cwd, pathParam)
    if (resolved === null) {
      respondError(res, 400, "INVALID_PATH", "path 非法或越出会话工作区")
      return
    }
    let info
    try {
      info = await stat(resolved)
    } catch (error) {
      if (error.code === "ENOENT") {
        respondJson(res, 200, { ok: true, file: null })
        return
      }
      respondError(res, 500, "STAT_FAILED", "文件信息读取失败")
      return
    }
    if (!info.isFile()) {
      respondJson(res, 200, { ok: true, file: null })
      return
    }
    const name = sanitizeFileName(basename(resolved)) ?? "file"
    respondJson(res, 200, {
      ok: true,
      file: {
        name,
        mediaType: mediaTypeOf(name),
        bytes: info.size,
        relativePath: relative(target.cwd, resolved),
      },
    })
    return
  }

  if (method === "DELETE" && pathname === `${ROUTE_PREFIX}/remove`) {
    const name = sanitizeFileName(url.searchParams.get("name"))
    if (name === null) {
      respondError(res, 400, "INVALID_FILENAME", "文件名缺失或非法")
      return
    }
    try {
      await unlink(join(target.dir, name))
    } catch (error) {
      if (error.code === "ENOENT") {
        respondError(res, 404, "FILE_NOT_FOUND", "文件不存在")
        return
      }
      ctx.logger?.warn?.(`${PLUGIN}: remove failed: ${error.message ?? error}`)
      respondError(res, 500, "REMOVE_FAILED", "删除失败")
      return
    }
    respondJson(res, 200, { ok: true, removed: true })
    return
  }

  if (method === "POST" && pathname === `${ROUTE_PREFIX}/upload`) {
    await handleUpload(ctx, config, cleanSessionId, req, res)
    return
  }

  respondError(res, 404, "NOT_FOUND", "接口不存在")
}

/**
 * 处理上传:解析 multipart → 文件流式写临时文件 → 全部成功后 rename 到最终名,
 * 任一失败则整体失败并清理本次上传写入的文件。
 *
 * sessionId 取 multipart 字段(必须,且必须先于文件部件到达);query 提供时
 * 两者必须一致(防跨会话写入)。目录在字段到达时确定并创建(仅上传时创建)。
 */
async function handleUpload(ctx, config, querySessionId, req, res) {
  const boundary = boundaryOf(req.headers["content-type"])
  if (boundary === null) {
    respondError(res, 400, "BAD_CONTENT_TYPE", "需要 multipart/form-data")
    return
  }

  const uploaded = [] // { name, mediaType, finalName, tmpPath, bytes }
  const targetHolder = { target: null }
  let parseError = null

  const finishUpload = async () => {
    // 清理:删除本次写入的所有临时文件(成功请求 rename 后这些路径已不存在,force 幂等)
    for (const file of uploaded) {
      await rm(file.tmpPath, { force: true }).catch(() => {})
    }
  }

  try {
    await parseMultipart(req, {
      boundary,
      maxFieldBytes: MAX_FIELD_BYTES,
      maxFileBytes: config.maxUploadBytes,
      tmpDir: () => (targetHolder.target !== null ? targetHolder.target.dir : null),
      onField: (name, value) => {
        if (name !== "sessionId") return
        const fieldSessionId = sanitizeSessionId(value)
        if (fieldSessionId === null) throw fail("INVALID_SESSION", "sessionId 非法")
        if (querySessionId !== null && querySessionId !== fieldSessionId) {
          throw fail("SESSION_MISMATCH", "表单 sessionId 与请求会话不一致")
        }
        const target = resolveUploadTarget(ctx, fieldSessionId)
        if (target === null) throw fail("SESSION_NOT_FOUND", "会话不存在或未加载")
        // 只有真正收到上传才创建目录(mkdirSync 一次,仅此路径会创建)
        mkdirSync(target.dir, { recursive: true })
        targetHolder.target = target
      },
      onFile: (file) => {
        uploaded.push(file)
      },
    })
  } catch (error) {
    parseError = error
  }

  // 校验:必须有成功的会话解析 + 至少一个文件
  if (parseError === null && targetHolder.target === null) {
    parseError = fail("INVALID_SESSION", "缺少 sessionId 字段")
  }
  if (parseError === null && uploaded.length === 0) {
    parseError = fail("NO_FILE", "未收到文件")
  }
  if (parseError !== null) {
    await finishUpload()
    const status = parseError.code === "FILE_TOO_LARGE" ? 413 : 400
    respondJson(res, status, { ok: false, error: { code: parseError.code, message: parseError.message } })
    req.resume() // 排空剩余请求体,保持连接可用
    return
  }

  const target = targetHolder.target
  // 全部文件:rename 临时文件到最终名(覆盖同名);提交失败时一并清理已提交文件
  const entries = []
  const committed = []
  try {
    for (const file of uploaded) {
      await rename(file.tmpPath, join(target.dir, file.finalName))
      committed.push(join(target.dir, file.finalName))
      entries.push({
        name: file.finalName,
        mediaType: file.mediaType,
        bytes: file.bytes,
        at: Date.now(),
      })
    }
  } catch (error) {
    await finishUpload()
    for (const path of committed) await rm(path, { force: true }).catch(() => {})
    respondJson(res, 500, { ok: false, error: { code: "COMMIT_FAILED", message: "文件落盘失败" } })
    return
  }
  await finishUpload()

  // 引导 LLM:注入一条 user 消息,告诉模型本会话的上传目录与文件清单
  try {
    const agent = target.agent
    if (typeof agent.inject === "function") {
      agent.inject(createUserMessage({
        content: [{ type: "text", text: uploadGuidanceText(target.cwd, target.agent.id, entries) }],
        source: { kind: "plugin", plugin: PLUGIN },
      }))
    }
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN}: guidance inject failed: ${error.message ?? error}`)
  }

  respondJson(res, 200, { ok: true, file: entries[entries.length - 1], files: entries })
}

/** Content-Disposition 的 ASCII 回退文件名。 */
function asciiFallback(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return ascii.length === 0 ? "file" : ascii
}

//#endregion

//#region share_session_file 工具

/** 模型「提供文件下载」工具的描述(模型可见,引导模型在用户索要文件时使用)。 */
const SHARE_TOOL_DESCRIPTION = [
  `把工作区内的一个文件提供给用户下载:用户会在对话流中看到文件卡片(名称/类型/大小),点击即可下载保存。`,
  `适用场景:用户说「把文件发给我 / 发到对话里 / 提供下载」;或你处理完文件(报告、打包结果、图片、表格、`,
  `日程等成品)时,用本工具把成品交给用户——不要只告诉用户文件路径。`,
  `参数 path:文件路径——绝对路径,或相对当前会话工作目录的相对路径;必须解析到本会话工作区内,`,
  `不能越界(如 ../ 或 /etc 等)。分享时直接引用文件原路径,不要把文件复制进 uploads/ 目录——`,
  `该目录专用于用户主动上传的文件,会显示在「已上传」列表里。`,
  `参数 name(可选):下载时显示的文件名(默认取文件本身的 basename)。`,
  `参数 description(可选):卡片上的一句话说明,可省略。`,
].join("")

/**
 * 注册 share_session_file 工具;返回释放函数。
 * 模型调用后,客户端按工具名在对话流中渲染下载卡片。
 */
function registerShareTool(ctx, config) {
  const tools = ctx.get("tools") ?? ctx.tools
  if (tools === undefined || typeof tools.register !== "function") {
    ctx.logger?.warn?.(`${PLUGIN}: tools 服务不可用,${SHARE_TOOL_NAME} 未注册`)
    return () => {}
  }
  const dispose = tools.register(defineTool({
    name: SHARE_TOOL_NAME,
    description: SHARE_TOOL_DESCRIPTION,
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "要提供给用户下载的文件路径(绝对路径或相对本会话工作目录;必须位于工作区内)",
      },
      name: {
        type: "string",
        description: "下载显示名(可省略,默认取文件 basename)",
      },
      description: {
        type: "string",
        description: "卡片上的一句话说明(可省略)",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", required: true },
          mediaType: { type: "string", required: true },
          bytes: { type: "number", required: true },
          path: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `已将文件提供给用户下载:${value.name}(${value.bytes} 字节,${value.mediaType},路径 ${value.path})。用户可在对话流中点击卡片下载。`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error(`${SHARE_TOOL_NAME} 缺少调用会话上下文`)
      const cwd = agent.session?.header?.cwd
      if (typeof cwd !== "string" || cwd.length === 0) throw new Error("无法确定会话工作目录")
      const rawPath = typeof args?.path === "string" ? args.path : ""
      const resolved = resolveWorkspacePath(cwd, rawPath)
      if (resolved === null) {
        throw new Error(`path 非法或越出会话工作区:${JSON.stringify(rawPath)}(必须解析到 ${cwd} 内)`)
      }
      let info
      try {
        info = await stat(resolved)
      } catch (error) {
        throw new Error(`文件不存在或不可读:${rawPath}(${error?.code ?? error?.message ?? error})`)
      }
      if (!info.isFile()) throw new Error(`不是普通文件,无法分享:${rawPath}`)
      if (info.size > config.maxUploadBytes) {
        throw new Error(`文件过大:${rawPath}(${info.size} 字节,上限 ${config.maxUploadBytes} 字节)`)
      }
      const fallback = basename(resolved)
      const name = sanitizeFileName(typeof args?.name === "string" && args.name.length > 0 ? args.name : fallback)
        ?? sanitizeFileName(fallback)
        ?? "file"
      return {
        name,
        mediaType: mediaTypeOf(name),
        bytes: info.size,
        path: relative(cwd, resolved),
      }
    },
  }))
  return () => dispose?.()
}

//#endregion

/** 插件主体:注册路由 + 分享工具 + 会话启动钩子。 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const webServer = ctx.get("webServer")
  if (webServer !== undefined && typeof webServer.register === "function") {
    const disposer = webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        handleRequest(ctx, resolved, req, res).catch((error) => {
          ctx.logger?.warn?.(`${PLUGIN}: route error: ${error?.message ?? error}`)
          if (!res.headersSent) respondError(res, 500, "INTERNAL", "内部错误")
          else res.destroy()
        })
      },
    })
    ctx.effect(() => () => disposer?.())
  } else {
    ctx.logger?.warn?.(`${PLUGIN}: webServer 服务不可用,路由未注册`)
  }

  // 模型「提供文件下载」工具
  const disposeShareTool = registerShareTool(ctx, resolved)
  ctx.effect(() => () => disposeShareTool?.())

  // 会话启动/恢复:若上传目录已存在(之前上传过),提醒模型本会话的上传目录。
  // 目录不存在时不做任何事——绝不在没有上传的情况下创建目录。
  const onSessionStart = ({ agent }) => {
    try {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== "string" || cwd.length === 0) return
      const dir = join(cwd, UPLOAD_DIR_NAME, agent.id)
      stat(dir).then((info) => {
        if (!info.isDirectory()) return
        const registry = ctx.get("agents")
        if (registry === undefined || registry.get(agent.id) !== agent) return
        if (typeof agent.inject !== "function") return
        agent.inject(createUserMessage({
          content: [{ type: "text", text: resumeGuidanceText(cwd, agent.id) }],
          source: { kind: "plugin", plugin: PLUGIN },
        }))
      }, () => {
        /* 目录不存在:忽略 */
      })
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: session-start hook failed: ${error?.message ?? error}`)
    }
  }
  ctx.on("agent/session-start", onSessionStart)
  ctx.effect(() => () => ctx.off("agent/session-start", onSessionStart))
}

export const inject = ["webServer"]

export default { apply, inject, Config }

export { Config, SHARE_TOOL_NAME, UPLOAD_DIR_NAME, relativeUploadDir, resolveWorkspacePath, sanitizeFileName, sanitizeSessionId }