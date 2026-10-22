/**
 * asar.mjs — app.asar 补丁核心
 *
 * 供 DSH 插件与 CLI 共用：读取 asar 头、读/替换 lib/main.js、
 * 应用"窗口记忆"补丁、从备份还原。
 *
 * asar 格式要点：
 *   - 前 16 字节：8 字节头（无用）+ 4 字节空 + 4 字节 header JSON 长度
 *   - 16 字节起：header JSON（条目 offset 相对数据区起点，且必须是字符串）
 *   - 数据区起点：16 + headerSize
 */

import {
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  copyFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";

// ---------------------------------------------------------------------------
// 补丁片段（与 bin/patch.mjs 保持一致）
// ---------------------------------------------------------------------------

const HELPER = `function windowStateFile() {
\treturn join(app.getPath("userData"), "window-state.json");
}
function readWindowState() {
\ttry {
\t\tconst state = JSON.parse(readFileSync(windowStateFile(), "utf8"));
\t\tif (state === null || typeof state !== "object") return void 0;
\t\tfor (const key of ["x", "y", "width", "height"]) {
\t\t\tif (typeof state[key] !== "number" || !Number.isFinite(state[key])) return void 0;
\t\t}
\t\tif (state.width < 520 || state.height < 600) return void 0;
\t\treturn state;
\t} catch {
\t\treturn void 0;
\t}
}
function isWindowStateVisible(state) {
\ttry {
\t\tconst area = screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height }).workArea;
\t\treturn state.x + state.width > area.x + 80 && state.x < area.x + area.width - 80 && state.y + state.height > area.y + 80 && state.y < area.y + area.height - 80;
\t} catch {
\t\treturn false;
\t}
}
function saveWindowState(window) {
\tif (window.isDestroyed()) return;
\ttry {
\t\tconst bounds = window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds();
\t\twriteFileSync(windowStateFile(), JSON.stringify({
\t\t\tx: bounds.x,
\t\t\ty: bounds.y,
\t\t\twidth: bounds.width,
\t\t\theight: bounds.height,
\t\t\tmaximized: window.isMaximized()
\t\t}));
\t} catch {}
}
function trackWindowState(window) {
\tlet timer;
\tconst schedule = () => {
\t\tclearTimeout(timer);
\t\ttimer = setTimeout(() => saveWindowState(window), 400);
\t};
\twindow.on("resize", schedule);
\twindow.on("move", schedule);
\twindow.on("maximize", schedule);
\twindow.on("unmaximize", schedule);
\twindow.on("close", () => saveWindowState(window));
\twindow.on("hide", () => saveWindowState(window));
}
`;

const IMPORT_ANCHOR = `session, shell, systemPreferences } from "electron";`;
const IMPORT_REPLACE = `session, screen, shell, systemPreferences } from "electron";`;

const CW_ANCHOR = `function createWindow(preload, show = false, primary = false) {`;
const CW_REPLACE =
  HELPER +
  `function createWindow(preload, show = false, primary = false) {
\tconst savedState = primary ? readWindowState() : void 0;
\tconst restored = savedState !== void 0 && isWindowStateVisible(savedState);`;

const OPTS_ANCHOR = `const window = new BrowserWindow({
\t\twidth: 1280,
\t\theight: 820,`;
const OPTS_REPLACE = `const window = new BrowserWindow({
\t\twidth: 1280,
\t\theight: 820,
\t\t...restored ? {
\t\t\tx: savedState.x,
\t\t\ty: savedState.y,
\t\t\twidth: savedState.width,
\t\t\theight: savedState.height
\t\t} : {},`;

const TAIL_ANCHOR = `\t\tif (["http:", "https:"].includes(destination.protocol)) shell.openExternal(url);
\t\t}
\t});
\treturn window;
}`;
const TAIL_REPLACE = `\t\tif (["http:", "https:"].includes(destination.protocol)) shell.openExternal(url);
\t\t}
\t});
\tif (primary) {
\t\ttrackWindowState(window);
\t\tif (restored && savedState.maximized === true) window.maximize();
\t}
\treturn window;
}`;

// ---------------------------------------------------------------------------
// 读写 asar
// ---------------------------------------------------------------------------

/** 读 asar 头。返回 { header, headerSize, dataOffset }。 */
export function readHeader(file) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    const headerSize = b.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, 16);
    const header = JSON.parse(headerBuf.toString("utf8"));
    return { header, headerSize, dataOffset: 16 + headerSize };
  } finally {
    closeSync(fd);
  }
}

/** 取 asar 内的文件条目（路径用 / 分隔）。 */
export function getEntry(header, p) {
  const parts = p.split("/");
  let cur = header.files;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!cur || !cur[part]) return null;
    const entry = cur[part];
    if (i === parts.length - 1) return entry.files ? null : entry;
    cur = entry.files || null;
    if (!cur) return null;
  }
  return null;
}

/** 读 asar 内某个文件的内容。 */
export function readEntry(file, header, dataOffset, p) {
  const entry = getEntry(header, p);
  if (!entry) return null;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(entry.size);
    readSync(fd, buf, 0, entry.size, dataOffset + parseInt(entry.offset, 10));
    return buf;
  } finally {
    closeSync(fd);
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function computeIntegrity(buf) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let off = 0; off < buf.length; off += blockSize) {
    blocks.push(sha256(buf.subarray(off, Math.min(off + blockSize, buf.length))));
  }
  return { algorithm: "SHA256", hash: sha256(buf), blockSize, blocks };
}

// ---------------------------------------------------------------------------
// 补丁 / 还原
// ---------------------------------------------------------------------------

/** 对 lib/main.js 源码应用补丁。锚点不匹配时抛错。 */
export function patchSource(src) {
  if (src.includes("function windowStateFile()")) {
    throw new Error("这个 app.asar 已经打过窗口记忆补丁，无需重复打。");
  }
  let out = src;
  const steps = [
    ["electron import（补 screen）", IMPORT_ANCHOR, IMPORT_REPLACE],
    ["createWindow 函数头", CW_ANCHOR, CW_REPLACE],
    ["BrowserWindow 选项", OPTS_ANCHOR, OPTS_REPLACE],
    ["createWindow 结尾", TAIL_ANCHOR, TAIL_REPLACE],
  ];
  for (const [name, anchor, replacement] of steps) {
    const count = out.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(
        `锚点不匹配（${name}）：期望出现 1 次，实际 ${count} 次。` +
          "这个 DSH 版本的 main.js 结构与补丁模板不同，升级后请反馈或自行适配。"
      );
    }
    out = out.replace(anchor, replacement);
  }
  return out;
}

/** 自动探测 app.asar 路径。 */
export function findAsar(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  if (process.env.DSH_ASAR && existsSync(process.env.DSH_ASAR)) {
    return process.env.DSH_ASAR;
  }
  // 从宿主进程参数推导：.../resources/app.asar.unpacked/dsh/node_modules/.../dsh-desktop-host/lib/index.js
  const entries = [process.argv[1], process.execPath].filter(Boolean);
  for (const p of entries) {
    const idx = p.toLowerCase().lastIndexOf("app.asar.unpacked");
    if (idx !== -1) {
      const resources = p.slice(0, idx).replace(/[\\/]+$/, "");
      const candidate = join(resources, "app.asar");
      if (existsSync(candidate)) return candidate;
    }
  }
  const candidates = [
    "F:\\DeepSeek Harness\\resources\\app.asar",
    join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness", "resources", "app.asar"),
    join(process.env.PROGRAMFILES || "", "DeepSeek Harness", "resources", "app.asar"),
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** 检查 asar：存在、能否读、是否已打补丁。 */
export function inspectAsar(file) {
  if (!file || !existsSync(file)) {
    return { path: file || null, exists: false, patched: false };
  }
  try {
    const { header, dataOffset } = readHeader(file);
    const mainBuf = readEntry(file, header, dataOffset, "lib/main.js");
    if (!mainBuf) return { path: file, exists: true, patched: false, error: "app.asar 里没有 lib/main.js" };
    const src = mainBuf.toString("utf8");
    return {
      path: file,
      exists: true,
      patched: src.includes("function windowStateFile()"),
      size: statSync(file).size,
      mainSize: mainBuf.length,
    };
  } catch (e) {
    return { path: file, exists: true, patched: false, error: String(e.message || e) };
  }
}

/**
 * 给 app.asar 打补丁。
 * @returns {{ patched: boolean, backup: string, message: string }}
 */
export function applyAsarPatch(file, { noBackup = false } = {}) {
  if (!existsSync(file)) throw new Error(`找不到 app.asar：${file}`);

  const { header, headerSize, dataOffset } = readHeader(file);
  const mainEntry = getEntry(header, "lib/main.js");
  if (!mainEntry) throw new Error("app.asar 里没有 lib/main.js，这不像 DSH 桌面版资源。");

  const mainBuf = readEntry(file, header, dataOffset, "lib/main.js");
  if (!mainBuf) throw new Error("读取 lib/main.js 失败。");

  const src = mainBuf.toString("utf8");
  const patched = patchSource(src);
  const newBytes = Buffer.from(patched, "utf8");
  const originalSize = statSync(file).size;

  let backup = null;
  if (!noBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${file}.bak-${stamp}`;
    copyFileSync(file, backup);
  }

  const fd = openSync(file, "r+");
  try {
    writeSync(fd, newBytes, 0, newBytes.length, originalSize);

    mainEntry.size = newBytes.length;
    mainEntry.offset = String(originalSize - dataOffset);
    mainEntry.integrity = computeIntegrity(newBytes);

    let json = JSON.stringify(header);
    let newHeaderBuf = Buffer.from(json, "utf8");

    if (newHeaderBuf.length > headerSize) {
      delete mainEntry.integrity;
      json = JSON.stringify(header);
      newHeaderBuf = Buffer.from(json, "utf8");
    }
    if (newHeaderBuf.length > headerSize) {
      throw new Error(
        `新 header 长度（${newHeaderBuf.length}）超过原长度（${headerSize}），无法安全替换。` +
          (backup ? `（备份在 ${backup}）` : "")
      );
    }
    if (newHeaderBuf.length < headerSize) {
      newHeaderBuf = Buffer.concat([
        newHeaderBuf,
        Buffer.alloc(headerSize - newHeaderBuf.length, 0x20),
      ]);
    }
    writeSync(fd, newHeaderBuf, 0, newHeaderBuf.length, 16);
  } finally {
    closeSync(fd);
  }

  return {
    patched: true,
    backup,
    message: `补丁完成。重新启动 DeepSeek Harness 生效；窗口状态会保存到 userData/window-state.json。`,
  };
}

/** 用最近的 .bak 备份还原 app.asar。 */
export function restoreAsar(file) {
  const dir = dirname(file);
  const base = basename(file);
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  const backups = readdirSync(dir)
    .filter((n) => n.startsWith(base + ".bak-"))
    .sort()
    .reverse();
  if (!backups.length) throw new Error(`没有找到 ${file} 的备份（*.bak-*）。`);
  const latest = join(dir, backups[0]);
  copyFileSync(latest, file);
  return { restored: true, backup: latest, message: `已从 ${latest} 还原。` };
}
