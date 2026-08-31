/**
 * dsh-session-files — Client half (v0.2.0)
 *
 * 功能一「上传」:输入区左侧「上传文件」按钮,任意文件上传到当前会话工作区
 * 的 uploads/<sessionId>/ 目录;服务端注入消息引导模型知道目录。
 *
 * 功能二「模型提供下载」(v0.2.0):模型调用 share_session_file 工具把工作区内
 * 的文件提供给用户;本端通过 tool.call.toolview 槽位(按工具名 keyed)为
 * 该工具渲染专用的「文件下载卡片」——显示文件名、类型、大小与说明,
 * 点击即下载。工具调用历史是持久化的,卡片在对话流中跨重启保留。
 *
 * 本端只负责:
 * - 输入区左侧按钮(conversation.input.left)+ 隐藏 file input(可多选);
 * - 输入区上方 dock(conversation.input.dock)显示已上传文件芯片:
 *   点击打开/预览,× 删除;
 * - 对话流中 share_session_file 调用的文件下载卡片(tool.call.toolview);
 * - 设置页(settings.section)开关。
 *
 * 数据通路:同源 /
 *   POST   /dsh-session-files/upload      (multipart;字段 sessionId + file)
 *   GET    /dsh-session-files/list?sessionId=..
 *   GET    /dsh-session-files/file?sessionId=..&path=.. (下载工作区内文件)
 *   GET    /dsh-session-files/share-info?sessionId=..&path=.. (卡片元信息)
 *   DELETE /dsh-session-files/remove?sessionId=..&name=..
 *   GET    /dsh-session-files/config
 *
 * License: MIT
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-session-files",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    // DSH 官方图标库(与 shell 一致的外观)
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    //#region styles
    const NS = "dsf"; // dsh session files
    const css = `
      .${NS}-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border: none; border-radius: 8px;
        background: transparent; color: var(--dsw-alias-label-tertiary);
        cursor: pointer; padding: 0; font-family: inherit;
        flex: none; line-height: 1; position: relative;
      }
      .${NS}-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .${NS}-btn:disabled { cursor: default; opacity: .45; }
      .${NS}-btn:focus-visible { outline: 2px solid var(--dsw-alias-label-tertiary); outline-offset: -2px; border-radius: 8px; }
      .${NS}-badge {
        position: absolute; top: -3px; right: -3px; min-width: 13px; height: 13px;
        border-radius: 999px; background: var(--dsw-alias-state-business-primary);
        color: var(--dsw-alias-bg-layer-1); font-size: 9px; font-weight: 700;
        display: inline-flex; align-items: center; justify-content: center; padding: 0 3px;
        box-sizing: border-box;
      }
      .${NS}-dock {
        box-sizing: border-box; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
        max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
        margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);
        padding: 0 var(--dsh-composer-dock-inset); flex: none;
      }
      .${NS}-panel {
        background: var(--dsw-specific-tip); border: 1px solid var(--dsw-alias-border-l1);
        border-bottom: none; border-radius: 12px 12px 0 0;
        padding: 6px 10px 7px; display: flex; flex-direction: column; gap: 5px;
      }
      .${NS}-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; min-height: 18px; }
      .${NS}-headTitle { font-weight: 600; color: var(--dsw-alias-label-primary); flex: none; }
      .${NS}-dir {
        min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: var(--dsw-alias-label-tertiary); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        cursor: default;
      }
      .${NS}-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
      .${NS}-chip {
        display: inline-flex; align-items: center; gap: 6px; max-width: 260px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        font-size: 12px; line-height: 20px; padding: 1px 4px 1px 10px;
      }
      .${NS}-chipName {
        min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        text-decoration: none; color: inherit; cursor: pointer; font-family: inherit;
      }
      .${NS}-chipName:hover { color: var(--dsw-alias-brand-primary); }
      .${NS}-chipMeta { color: var(--dsw-alias-label-tertiary); font-size: 11px; flex: none; }
      .${NS}-chipX {
        flex: none; width: 18px; height: 18px; border: none; border-radius: 999px;
        background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
        font-size: 12px; line-height: 1; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-family: inherit;
      }
      .${NS}-chipX:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-state-error-primary); }
      .${NS}-uploading { color: var(--dsw-alias-label-tertiary); font-size: 12px; display: flex; align-items: center; gap: 6px; }
      .${NS}-spin {
        width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2);
        border-top-color: var(--dsw-alias-brand-primary); animation: ${NS}-spin .8s linear infinite; flex: none;
      }
      @keyframes ${NS}-spin { to { transform: rotate(360deg); } }
      .${NS}-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; word-break: break-all; }
      .${NS}-panel { color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 8px; }
      .${NS}-check { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; }
      .${NS}-check input { accent-color: var(--dsw-alias-brand-primary); }
      .${NS}-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.6; }
      .${NS}-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
      /* share_session_file 下载卡片 */
      .${NS}-share {
        display: flex; align-items: center; gap: 10px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        padding: 10px 12px; margin: 2px 0; min-width: 0;
      }
      .${NS}-share[data-state="running"] { color: var(--dsw-alias-label-tertiary); }
      .${NS}-share[data-state="stopped"] { color: var(--dsw-alias-label-tertiary); }
      .${NS}-share[data-state="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .${NS}-shareIcon {
        flex: none; width: 34px; height: 34px; border-radius: 9px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
        display: inline-flex; align-items: center; justify-content: center; font-size: 16px;
      }
      .${NS}-shareMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .${NS}-shareName {
        font-size: 13px; font-weight: 600; text-decoration: none; color: inherit;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
      }
      .${NS}-shareName:hover { color: var(--dsw-alias-brand-primary); }
      .${NS}-shareMeta { font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .${NS}-shareDesc { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.45; word-break: break-word; }
      .${NS}-shareBtn {
        flex: none; display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        padding: 4px 12px; font-size: 12px; line-height: 18px; text-decoration: none; cursor: pointer;
        font-family: inherit; font-weight: 500;
      }
      .${NS}-shareBtn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .${NS}-shareBtn:disabled { cursor: default; opacity: .5; }
      .${NS}-shareState { font-size: 12px; display: inline-flex; align-items: center; gap: 6px; color: inherit; }
    `;
    const tagId = "@deepseek-ai/dsh-session-files/widget.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-session-files";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region config (localStorage)
    const STORAGE_KEY = "dsh-session-files:config";
    const DEFAULTS = { enabled: true, showDock: true };
    function loadConfig() {
      let saved = null;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw !== null) saved = JSON.parse(raw);
      } catch (error) { saved = null; }
      if (saved === null || typeof saved !== "object") return { ...DEFAULTS };
      return {
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
        showDock: typeof saved.showDock === "boolean" ? saved.showDock : DEFAULTS.showDock,
      };
    }
    function saveConfig(cfg) {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); return true; } catch (error) { return false; }
    }
    //#endregion

    //#region store
    let snapshot = {
      status: "idle",        // idle | uploading
      sessionId: null,       // 当前锚定的会话
      addressed: false,      // 子代理会话(不上传)
      files: [],             // [{name, mediaType, bytes, at}]
      dir: null,             // 服务端返回的绝对目录
      relativeDir: null,     // 相对 cwd 的目录(uploads/<sessionId>/)
      uploading: 0,          // 剩余上传数
      uploadError: null,     // 上传失败信息
      config: null,          // 服务端配置 {maxUploadBytes, uploadDirName}
    };
    const listeners = new Set();
    function notify() {
      for (const fn of [...listeners]) { try { fn(); } catch (error) { console.log("dsh-session-files: listener failed", error); } }
    }
    function update(patch) {
      snapshot = { ...snapshot, ...patch };
      notify();
    }
    function subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }
    //#endregion

    //#region helpers
    function fmtSize(bytes) {
      if (!Number.isFinite(bytes)) return "";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }
    function fileUrl(sessionId, name, download) {
      const q = "sessionId=" + encodeURIComponent(String(sessionId)) + "&name=" + encodeURIComponent(name);
      return "/dsh-session-files/file?" + q + (download ? "&download=1" : "");
    }
    async function readBody(res) {
      let body = null;
      try { body = await res.json(); } catch (error) { body = null; }
      return body;
    }
    //#endregion

    //#region data flow
    let appCtx = null;
    let currentSessionId = null;

    async function loadConfigFromServer() {
      try {
        const res = await fetch("/dsh-session-files/config");
        const body = await readBody(res);
        if (res.ok && body !== null && body.ok === true) {
          update({ config: body.config });
        }
      } catch (error) {
        update({ config: null });
      }
    }

    async function refreshList() {
      const sid = currentSessionId;
      if (sid === null || snapshot.addressed) {
        update({ files: [], dir: null, relativeDir: null });
        return;
      }
      try {
        const res = await fetch("/dsh-session-files/list?sessionId=" + encodeURIComponent(String(sid)));
        const body = await readBody(res);
        if (res.ok && body !== null && body.ok === true) {
          update({
            files: Array.isArray(body.files) ? body.files : [],
            dir: typeof body.dir === "string" ? body.dir : null,
            relativeDir: typeof body.relativeDir === "string" ? body.relativeDir : null,
          });
        }
      } catch (error) {
        /* 服务不可达:保留旧数据 */
      }
    }

    async function uploadFiles(fileList) {
      const sid = currentSessionId;
      if (sid === null || fileList.length === 0) return;
      update({ uploading: fileList.length, uploadError: null });
      let failed = 0;
      let lastError = null;
      let done = 0;
      for (const file of fileList) {
        const form = new FormData();
        form.append("sessionId", String(sid));
        form.append("file", file, file.name);
        try {
          const res = await fetch("/dsh-session-files/upload", { method: "POST", body: form });
          const body = await readBody(res);
          if (!res.ok || body === null || body.ok !== true) {
            failed += 1;
            lastError = body !== null && body.error && typeof body.error === "object" && typeof body.error.message === "string"
              ? body.error.message
              : "HTTP " + res.status;
          }
        } catch (error) {
          failed += 1;
          lastError = error && error.message ? String(error.message) : String(error);
        }
        done += 1;
        update({ uploading: fileList.length - done });
      }
      if (failed > 0) {
        update({ uploadError: "上传失败 " + failed + "/" + fileList.length + " 个文件" + (lastError !== null ? ": " + lastError : "") });
      }
      await refreshList();
    }

    async function removeFile(name) {
      const sid = currentSessionId;
      if (sid === null) return;
      try {
        const res = await fetch("/dsh-session-files/remove?sessionId=" + encodeURIComponent(String(sid)) + "&name=" + encodeURIComponent(name), { method: "DELETE" });
        const body = await readBody(res);
        if (!res.ok || body === null || body.ok !== true) {
          const message = body !== null && body.error && typeof body.error === "object" && typeof body.error.message === "string"
            ? body.error.message
            : "HTTP " + res.status;
          update({ uploadError: "删除失败: " + message });
        }
      } catch (error) {
        update({ uploadError: "删除失败: " + (error && error.message ? String(error.message) : String(error)) });
      }
      await refreshList();
    }

    function anchorSession() {
      if (appCtx === null) return;
      let sid = null;
      let addressed = false;
      try {
        const list = appCtx.sessions && appCtx.sessions.list ? appCtx.sessions.list : null;
        const snap = list !== null ? list.getSnapshot() : undefined;
        sid = snap !== undefined && snap !== null ? snap.current : undefined;
        if (sid !== undefined && sid !== null) {
          addressed = typeof appCtx.sessions.subagentAddress === "function"
            && appCtx.sessions.subagentAddress(sid) !== undefined;
        }
      } catch (error) {
        sid = null;
      }
      if (sid === undefined || sid === null) sid = null;
      if (sid !== currentSessionId || addressed !== snapshot.addressed) {
        currentSessionId = sid;
        update({ sessionId: sid, addressed, files: [], dir: null, relativeDir: null, uploadError: null });
        refreshList();
      } else {
        update({ sessionId: sid, addressed });
      }
    }

    function setupWatchers() {
      teardownWatchers();
      let listDisposer = null;
      try {
        listDisposer = appCtx.sessions.list.subscribe(() => { anchorSession(); });
      } catch (error) {
        console.log("dsh-session-files: 会话列表订阅失败", error);
      }
      const onVisibility = () => { if (document.visibilityState === "visible") refreshList(); };
      document.addEventListener("visibilitychange", onVisibility);
      watchers = {
        dispose: () => {
          if (listDisposer !== null) { try { listDisposer(); } catch (error) {} }
          document.removeEventListener("visibilitychange", onVisibility);
        },
      };
    }
    let watchers = null;
    function teardownWatchers() {
      if (watchers !== null) {
        try { watchers.dispose(); } catch (error) {}
        watchers = null;
      }
    }
    //#endregion

    //#region UploadButton
    function UploadButton() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => subscribe(force), []);
      const cfg = loadConfig();
      const snap = snapshot;
      const enabled = cfg.enabled && snap.sessionId !== null && !snap.addressed && snap.uploading === 0;
      const inputRef = React.useRef(null);
      const [picked, setPicked] = React.useState(0);

      const onPick = (event) => {
        const input = event.currentTarget;
        const files = Array.from(input.files || []);
        input.value = "";
        if (files.length === 0) return;
        setPicked((n) => n + 1);
        uploadFiles(files).catch((error) => {
          update({ uploadError: error && error.message ? String(error.message) : String(error) });
        });
      };

      if (!cfg.enabled || snap.sessionId === null || snap.addressed) return null;

      const uploading = snap.uploading > 0;
      const title = uploading
        ? "正在上传…"
        : "上传文件到当前会话(任意类型,存放于工作区 " + (snap.relativeDir !== null ? snap.relativeDir : "uploads/<会话ID>") + "/)";

      return React.createElement(
        "span",
        { className: NS + "-btnWrap", style: { position: "relative", display: "inline-flex" } },
        React.createElement(
          "button",
          {
            type: "button",
            className: NS + "-btn",
            title: title,
            "aria-label": "上传文件",
            disabled: !enabled,
            onClick: () => { if (inputRef.current !== null) inputRef.current.click(); },
          },
          React.createElement(P.IconPaperclipOutline16, { size: 16 }),
          uploading
            ? React.createElement("span", { className: NS + "-badge" }, String(snap.uploading))
            : null,
        ),
        React.createElement("input", {
          ref: inputRef,
          type: "file",
          multiple: true,
          key: picked,
          hidden: true,
          onChange: onPick,
        }),
      );
    }
    //#endregion

    //#region FileDock
    function FileDock() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => subscribe(force), []);
      const cfg = loadConfig();
      const snap = snapshot;
      if (!cfg.enabled || !cfg.showDock || snap.sessionId === null || snap.addressed) return null;
      const files = snap.files;
      const uploading = snap.uploading > 0;
      const hasAny = files.length > 0 || uploading || snap.uploadError !== null;
      if (!hasAny) return null;

      const chips = files.map((file) =>
        React.createElement(
          "li",
          { key: file.name, className: NS + "-chip" },
          React.createElement(
            "a",
            {
              className: NS + "-chipName",
              href: fileUrl(snap.sessionId, file.name, false),
              target: "_blank",
              rel: "noreferrer",
              title: "打开/预览 " + file.name,
            },
            file.name,
          ),
          React.createElement("span", { className: NS + "-chipMeta" }, fmtSize(file.bytes)),
          React.createElement(
            "button",
            {
              type: "button",
              className: NS + "-chipX",
              title: "删除 " + file.name,
              "aria-label": "删除 " + file.name,
              onClick: () => { removeFile(file.name).catch(() => {}); },
            },
            React.createElement(P.IconCloseOutline16, { size: 12 }),
          ),
        ),
      );

      return React.createElement(
        "div",
        { className: NS + "-dock", "data-session-files-dock": "" },
        React.createElement(
          "div",
          { className: NS + "-panel" },
          React.createElement(
            "div",
            { className: NS + "-head" },
            React.createElement("span", { className: NS + "-headTitle", style: { display: "inline-flex", alignItems: "center", gap: 5 } },
              React.createElement(P.IconPaperclipOutline16, { size: 14 }),
              "已上传 " + files.length),
            snap.dir !== null
              ? React.createElement("span", { className: NS + "-dir", title: "本会话上传目录(绝对路径) " + snap.dir }, snap.dir)
              : null,
          ),
          files.length > 0 ? React.createElement("ul", { className: NS + "-chips" }, chips) : null,
          uploading
            ? React.createElement(
                "div",
                { className: NS + "-uploading" },
                React.createElement("span", { className: NS + "-spin" }),
                "上传中,剩余 " + snap.uploading + " 个…",
              )
            : null,
          snap.uploadError !== null
            ? React.createElement("div", { className: NS + "-error" }, snap.uploadError)
            : null,
        ),
      );
    }
    //#endregion

    //#region ShareFileCard (share_session_file 下载卡片)
    /** 取路径叶子名。 */
    function basenameOf(path) {
      const idx = Math.max(String(path).lastIndexOf("/"), String(path).lastIndexOf("\\"))
      return idx >= 0 ? String(path).slice(idx + 1) : String(path)
    }
    /** 扩展名 → 卡片上的粗类型标签。 */
    const SHARE_TYPE_LABELS = [
      [".pdf", "PDF 文档"],
      [".png", "图片"], [".jpg", "图片"], [".jpeg", "图片"], [".gif", "图片"], [".webp", "图片"], [".bmp", "图片"], [".svg", "图片"], [".avif", "图片"],
      [".zip", "压缩包"], [".tar", "压缩包"], [".gz", "压缩包"], [".7z", "压缩包"], [".rar", "压缩包"], [".xz", "压缩包"], [".bz2", "压缩包"],
      [".mp3", "音频"], [".wav", "音频"], [".ogg", "音频"], [".flac", "音频"], [".m4a", "音频"],
      [".mp4", "视频"], [".webm", "视频"], [".mov", "视频"], [".mkv", "视频"],
      [".xlsx", "表格"], [".csv", "表格"], [".tsv", "表格"],
      [".docx", "文档"], [".doc", "文档"], [".txt", "文本"], [".md", "Markdown"], [".markdown", "Markdown"],
      [".json", "JSON"], [".yml", "YAML"], [".yaml", "YAML"], [".xml", "XML"], [".html", "网页"], [".htm", "网页"],
      [".py", "Python"], [".js", "JS"], [".ts", "TS"], [".sh", "Shell"],
    ]
    function shareTypeLabel(name) {
      const dot = String(name).lastIndexOf(".")
      const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : ""
      for (const [candidate, label] of SHARE_TYPE_LABELS) if (candidate === ext) return label
      return ext === "" ? "文件" : ext.slice(1).toUpperCase() + " 文件"
    }
    function shareIconOf(name) {
      const label = shareTypeLabel(name)
      if (label === "PDF 文档") return P.IconListPenOutline16
      if (label === "图片") return P.IconBrowseOutline16
      if (label === "压缩包") return P.IconArchiveOutline20
      if (label === "音频") return P.IconPlayOutline16
      if (label === "视频") return P.IconPlayOutline16
      if (label === "表格") return P.IconDataOutline16
      if (label === "文档" || label === "Markdown" || label === "文本"
        || label === "JSON" || label === "YAML" || label === "XML" || label === "网页") return P.IconListPenOutline16
      if (label === "Python" || label === "JS" || label === "TS" || label === "Shell") return P.IconCodeOutline16
      return P.IconPaperclipOutline16
    }
    /** 解析工具调用参数(JSON),失败返回空对象。 */
    function parseShareArgs(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw === "") return {}
      try {
        const parsed = JSON.parse(argsRaw)
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
      } catch (error) {
        return {}
      }
    }
    /**
     * share_session_file 的下载卡片。
     * block 生命周期两态:running({argsRaw}) / done({kind, call:{argsRaw}, isError, error})。
     */
    function ShareFileCard({ block }) {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => subscribe(force), [])
      const done = typeof block === "object" && block !== null && "kind" in block
      const argsRaw = done ? block.call?.argsRaw ?? "" : block.argsRaw ?? ""
      const args = parseShareArgs(argsRaw)
      const state = !done ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok"
      const path = typeof args.path === "string" ? args.path : ""
      const displayName = typeof args.name === "string" && args.name.length > 0 ? args.name : path === "" ? "(未知文件)" : basenameOf(path)
      const description = typeof args.description === "string" && args.description.length > 0 ? args.description : null

      // 异步补全元信息(名称/类型/大小)与「文件是否还在」
      const [info, setInfo] = React.useState(null)
      const [infoState, setInfoState] = React.useState("pending") // pending | ok | missing
      const sid = snapshot.sessionId
      React.useEffect(() => {
        setInfo(null)
        setInfoState("pending")
        if (state !== "ok" || path === "" || sid === null) return
        let cancelled = false
        const url = "/dsh-session-files/share-info?sessionId=" + encodeURIComponent(String(sid)) + "&path=" + encodeURIComponent(path)
        fetch(url, { signal: AbortSignal.timeout(8000) }).then((res) => res.json()).then((body) => {
          if (cancelled) return
          if (body !== null && body.ok === true) {
            if (body.file !== null && typeof body.file === "object") {
              setInfo(body.file)
              setInfoState("ok")
            } else {
              setInfoState("missing")
            }
          }
        }).catch((error) => {
          if (!cancelled) setInfoState("pending")
        })
        return () => { cancelled = true }
      }, [state, path, sid])

      const downloadUrl = sid !== null && path !== ""
        ? "/dsh-session-files/file?sessionId=" + encodeURIComponent(String(sid)) + "&path=" + encodeURIComponent(path) + "&download=1"
        : null

      if (state === "running") {
        return React.createElement("div", { className: NS + "-share", "data-state": "running" },
          React.createElement("div", { className: NS + "-shareState" },
            React.createElement("span", { className: NS + "-spin" }),
            displayName === "(未知文件)" ? "正在分享文件…" : "正在分享文件「" + displayName + "」…"),
        )
      }
      if (state === "stopped") {
        return React.createElement("div", { className: NS + "-share", "data-state": "stopped" },
          React.createElement("div", { className: NS + "-shareState" }, "文件分享已中止"),
        )
      }
      if (state === "error") {
        return React.createElement("div", { className: NS + "-share", "data-state": "error" },
          React.createElement("div", { className: NS + "-shareState" }, "文件分享失败(文件可能不存在、越界或超出大小上限)"),
        )
      }

      const metaBits = [shareTypeLabel(displayName)]
      if (infoState === "ok" && info !== null && typeof info.bytes === "number") metaBits.push(fmtSize(info.bytes))
      if (infoState === "missing") metaBits.push("文件已不存在")
      const fullPath = info !== null && typeof info.relativePath === "string" ? info.relativePath : path

      return React.createElement(
        "div",
        { className: NS + "-share", "data-state": "ok", title: "路径: " + fullPath },
        React.createElement("span", { className: NS + "-shareIcon", "aria-hidden": true },
          React.createElement(shareIconOf(displayName), { size: 16 })),
        React.createElement(
          "div",
          { className: NS + "-shareMain" },
          downloadUrl !== null
            ? React.createElement("a", { className: NS + "-shareName", href: downloadUrl, target: "_blank", rel: "noreferrer", title: "点击下载" }, displayName)
            : React.createElement("span", { className: NS + "-shareName" }, displayName),
          React.createElement("span", { className: NS + "-shareMeta" }, metaBits.join(" · ")),
          description !== null ? React.createElement("span", { className: NS + "-shareDesc" }, description) : null,
        ),
        downloadUrl !== null
          ? React.createElement("a", { className: NS + "-shareBtn", href: downloadUrl, target: "_blank", rel: "noreferrer" },
              React.createElement(P.IconDownloadOutline16, { size: 14 }),
              "下载")
          : React.createElement("button", { type: "button", className: NS + "-shareBtn", disabled: true },
              React.createElement(P.IconDownloadOutline16, { size: 14 }),
              "下载"),
      )
    }
    //#endregion

    //#region SettingsPanel
    function SettingsPanel() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => subscribe(force), []);
      const [cfg, setCfg] = React.useState(loadConfig());
      const snap = snapshot;
      const save = (patch) => {
        const next = { ...cfg, ...patch };
        setCfg(next);
        saveConfig(next);
      };
      const maxUpload = snap.config && typeof snap.config.maxUploadBytes === "number" ? fmtSize(snap.config.maxUploadBytes) : null;
      return React.createElement(
        "div",
        { className: NS + "-panel" },
        React.createElement("label", { className: NS + "-check" },
          React.createElement("input", { type: "checkbox", checked: cfg.enabled, onChange: (e) => save({ enabled: e.target.checked }) }),
          "启用会话文件上传"),
        React.createElement("label", { className: NS + "-check" },
          React.createElement("input", {
            type: "checkbox",
            checked: cfg.showDock,
            onChange: (e) => save({ showDock: e.target.checked }),
          }),
          "在输入区上方显示已上传文件"),
        React.createElement(
          "div",
          { className: NS + "-note" },
          "点击输入区左侧的回形针图标可选择任意文件上传。文件会保存到当前会话工作区的 ",
          React.createElement("span", { className: NS + "-mono" }, "uploads/<会话ID>/"),
          " 目录,并在上传后自动告知模型本会话对应的目录。",
          maxUpload !== null ? " 单文件上限 " + maxUpload + "。" : "",
        ),
      );
    }
    //#endregion

    //#region plugin body
    const inject = ["slots", "sessions"];

    function apply(ctx) {
      appCtx = ctx;
      anchorSession();
      loadConfigFromServer();
      setupWatchers();

      ctx.on("connection/reset", () => {
        teardownWatchers();
        setupWatchers();
        anchorSession();
        loadConfigFromServer();
      });

      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "session-files-upload",
        order: 0,
      }, UploadButton));

      // 模型 share_session_file 调用 → 对话流文件下载卡片(按工具名 keyed,替换通用行)
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "share_session_file",
      }, ShareFileCard));

      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
        name: "conversation.input.dock",
        id: "session-files",
        order: 30,
      }, FileDock));

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "session-files",
        order: 30,
        label: "会话文件上传",
      }, SettingsPanel));

      ctx.effect(() => () => {
        teardownWatchers();
        appCtx = null;
        currentSessionId = null;
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});