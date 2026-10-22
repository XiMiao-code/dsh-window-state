#!/usr/bin/env node
/**
 * dsh-window-state-patch
 *
 * 让 DeepSeek Harness 桌面窗口记住关闭前的位置和大小，下次启动时恢复。
 *
 * 原理：给 DSH 安装目录下 resources/app.asar 内的 lib/main.js 打一个轻量补丁——
 *   窗口创建时读取 userData/window-state.json（不存在则用默认尺寸）；
 *   拖动 / 缩放 / 最大化 / 关闭时保存窗口位置与大小；
 *   下次启动时自动还原到上次关闭时的位置。
 *
 * 用法：
 *   node bin/patch.mjs                    # 自动探测 DSH 安装目录并打补丁
 *   node bin/patch.mjs <app.asar 路径>     # 手动指定 asar 路径
 *   node bin/patch.mjs --dry-run          # 只检查能否打补丁，不写任何文件
 *   node bin/patch.mjs --restore          # 用最近的备份还原 app.asar
 *   node bin/patch.mjs --no-backup        # 不备份（不推荐）
 *
 * 注意：DSH 升级 / 重装会用新的 app.asar 覆盖补丁，升级后重新运行本脚本即可。
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
import { join, dirname } from "node:path";

const NODE_MIN = [18, 0];

// ---------------------------------------------------------------------------
// 补丁代码（插入 lib/main.js）
// ---------------------------------------------------------------------------

/** 五个工具函数，插在 createWindow 之前。 */
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

/** 锚点 1：electron import，补上 screen。 */
const IMPORT_ANCHOR = `session, shell, systemPreferences } from "electron";`;
const IMPORT_REPLACE = `session, screen, shell, systemPreferences } from "electron";`;

/** 锚点 2：createWindow 函数头，前插 helper、后插读取逻辑。 */
const CW_ANCHOR = `function createWindow(preload, show = false, primary = false) {`;
const CW_REPLACE =
  HELPER +
  `function createWindow(preload, show = false, primary = false) {
\tconst savedState = primary ? readWindowState() : void 0;
\tconst restored = savedState !== void 0 && isWindowStateVisible(savedState);`;

/** 锚点 3：BrowserWindow 选项里插入位置尺寸。 */
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

/** 锚点 4：createWindow 返回前，挂上保存与最大化恢复。 */
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
// 小工具
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(msg);
}
function fail(msg) {
  console.error("✖ " + msg);
  process.exit(1);
}

function readU32(buf, off) {
  return buf.readUInt32LE(off);
}

/** 用 Node 直接读 asar 头，返回 { header, headerSize, dataOffset, headerBuf }。 */
function readHeader(file) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    const headerSize = readU32(b, 12);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, 16);
    const header = JSON.parse(headerBuf.toString("utf8"));
    return { header, headerSize, dataOffset: 16 + headerSize };
  } finally {
    closeSync(fd);
  }
}

function getEntry(header, p) {
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

function readEntry(file, header, dataOffset, p) {
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

/** 与 Electron asar 一致的分块 integrity。 */
function computeIntegrity(buf) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let off = 0; off < buf.length; off += blockSize) {
    blocks.push(sha256(buf.subarray(off, Math.min(off + blockSize, buf.length))));
  }
  return {
    algorithm: "SHA256",
    hash: sha256(buf),
    blockSize,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// 补丁 / 还原
// ---------------------------------------------------------------------------

/**
 * 对 lib/main.js 源码应用补丁。返回新源码；锚点不匹配时抛错。
 */
function patchSource(src) {
  if (src.includes("function windowStateFile()")) {
    throw new Error("这个 app.asar 已经打过窗口记忆补丁，无需重复打");
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
          `这个 DSH 版本的 main.js 结构与补丁模板不同，升级后请反馈或自行适配。`
      );
    }
    out = out.replace(anchor, replacement);
  }

  return out;
}

function findAsar(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR;
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

function applyPatch(file, { dryRun = false, noBackup = false } = {}) {
  if (!existsSync(file)) fail(`找不到 app.asar：${file}`);

  const { header, headerSize, dataOffset, headerBuf } = readHeader(file);
  const mainEntry = getEntry(header, "lib/main.js");
  if (!mainEntry) fail("app.asar 里没有 lib/main.js，这不像 DSH 桌面版资源");

  const mainBuf = readEntry(file, header, dataOffset, "lib/main.js");
  if (!mainBuf) fail("读取 lib/main.js 失败");

  const src = mainBuf.toString("utf8");
  let patched;
  try {
    patched = patchSource(src);
  } catch (e) {
    fail(e.message);
  }

  const newBytes = Buffer.from(patched, "utf8");
  const originalSize = statSync(file).size;

  if (dryRun) {
    log(`✔ 锚点全部匹配，可以打补丁`);
    log(`  新 lib/main.js：${src.length} 字符 → ${patched.length} 字符`);
    log(`  原文件：${originalSize} 字节，header ${headerSize} 字节`);
    return;
  }

  // ---- 备份 ----
  let backup = null;
  if (!noBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${file}.bak-${stamp}`;
    copyFileSync(file, backup);
    log(`✔ 已备份原版：${backup}`);
  }

  // ---- 写新 main.js 到文件末尾 ----
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, newBytes, 0, newBytes.length, originalSize);

    // ---- 更新 header entry ----
    mainEntry.size = newBytes.length;
    mainEntry.offset = String(originalSize - dataOffset);
    mainEntry.integrity = computeIntegrity(newBytes);

    let json = JSON.stringify(header);
    let newHeaderBuf = Buffer.from(json, "utf8");

    if (newHeaderBuf.length > headerSize) {
      // 长度超了：fuse 关闭时 integrity 不校验，去掉它来压缩 header
      delete mainEntry.integrity;
      json = JSON.stringify(header);
      newHeaderBuf = Buffer.from(json, "utf8");
    }
    if (newHeaderBuf.length > headerSize) {
      closeSync(fd);
      fail(
        `新 header 长度（${newHeaderBuf.length}）超过原长度（${headerSize}），无法安全替换。` +
          `请把 app.asar 发到 issue 里。` + (backup ? `（备份在 ${backup}）` : "")
      );
    }
    if (newHeaderBuf.length < headerSize) {
      // 空格补齐，保持数据区偏移不变
      const pad = Buffer.alloc(headerSize - newHeaderBuf.length, 0x20);
      newHeaderBuf = Buffer.concat([newHeaderBuf, pad]);
    }

    // header 长度字段不变，直接覆盖原 header 区
    writeSync(fd, newHeaderBuf, 0, newHeaderBuf.length, 16);
  } finally {
    closeSync(fd);
  }

  log(`✔ 补丁完成：${file}`);
  log(`  新 lib/main.js：${newBytes.length} 字节（原 ${mainBuf.length} 字节）`);
  log(`  窗口状态文件：<userData>/window-state.json`);
  log(``);
  log(`👉 重新启动 DeepSeek Harness 生效。拖动窗口后状态会自动保存。`);
}

function restore(file) {
  const dir = dirname(file);
  const base = file.slice(dir.length + 1);
  const backups = readdirSync(dir)
    .filter((n) => n.startsWith(base + ".bak-"))
    .sort()
    .reverse();
  if (!backups.length) fail(`没有找到 ${file} 的备份`);
  const latest = join(dir, backups[0]);
  copyFileSync(latest, file);
  log(`✔ 已从 ${latest} 还原：${file}`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    log("用法：node bin/patch.mjs [app.asar 路径] [--dry-run | --restore | --no-backup]");
    return;
  }

  const nodeVer = process.versions.node.split(".").map(Number);
  if (nodeVer[0] < NODE_MIN[0]) {
    fail(`需要 Node.js >= ${NODE_MIN.join(".")}，当前 ${process.versions.node}`);
  }

  const file = args.find((a) => !a.startsWith("--")) || findAsar(null);
  if (!file) {
    fail(
      "没有找到 DeepSeek Harness 的 app.asar。请把安装目录传进来，例如：\n" +
        `  node bin/patch.mjs "F:\\DeepSeek Harness\\resources\\app.asar"`
    );
  }

  if (args.includes("--restore")) {
    restore(file);
    return;
  }

  applyPatch(file, {
    dryRun: args.includes("--dry-run"),
    noBackup: args.includes("--no-backup"),
  });
}

main();
