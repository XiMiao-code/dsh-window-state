/**
 * dsh-window-state — DSH 插件（host 侧）
 *
 * 让 DeepSeek Harness 桌面窗口记住关闭前的位置和大小，下次启动时恢复。
 *
 * 插件本身跑在 dsh-desktop-host 子进程里（没有 BrowserWindow），
 * 所以它提供的是一个本地控制页 + JSON API：
 *   - GET  /dsh-window-state/        内置控制页（浏览器直接打开）
 *   - GET  /dsh-window-state/status  当前状态（asar 是否已打补丁、窗口状态文件）
 *   - POST /dsh-window-state/apply   一键给 app.asar 打补丁
 *   - POST /dsh-window-state/restore 从备份还原 app.asar
 *
 * 打补丁后需要重启 DeepSeek Harness 桌面应用才会生效。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyAsarPatch,
  findAsar,
  inspectAsar,
  restoreAsar,
} from "./asar.mjs";
import { renderPage } from "./page.mjs";

export const name = "dsh-window-state";
export const inject = ["webServer"];

const BASE = "/dsh-window-state";

/** userData 下的窗口状态文件（@deepseek-ai/dsh-desktop 是桌面版的 productName）。 */
function stateFileCandidates() {
  const appData = process.env.APPDATA || "";
  const out = [];
  if (appData) {
    out.push(join(appData, "@deepseek-ai", "dsh-desktop", "window-state.json"));
    // 兜底：扫描 AppData/Roaming 下带 dsh-desktop 名字的目录
    try {
      for (const d of readdirSync(join(appData, "@deepseek-ai"), { withFileTypes: true })) {
        if (d.isDirectory() && d.name.toLowerCase().includes("dsh-desktop")) {
          out.push(join(appData, "@deepseek-ai", d.name, "window-state.json"));
        }
      }
    } catch {}
  }
  return [...new Set(out)];
}

function readStateFile() {
  for (const p of stateFileCandidates()) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8");
      return { path: p, exists: true, raw, value: JSON.parse(raw) };
    } catch (e) {
      return { path: p, exists: true, raw: null, value: null, error: String(e.message || e) };
    }
  }
  return { path: stateFileCandidates()[0] || null, exists: false, value: null };
}

function statusPayload() {
  const asar = findAsar(null);
  const info = inspectAsar(asar);
  return {
    ok: true,
    app: "DeepSeek Harness Desktop",
    asar: info,
    stateFile: readStateFile(),
    hint: info.patched
      ? "补丁已就位。重启 DeepSeek Harness 后，窗口位置和大小会被记住。"
      : "还没有打补丁。点击「打补丁」，然后重启 DeepSeek Harness。",
  };
}

export function apply(ctx) {
  const disposers = [];
  const logger =
    typeof ctx.logger === "function"
      ? ctx.logger("dsh-window-state")
      : { info: () => {}, warn: () => {}, error: () => {} };

  const json = (res, data) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(data));
  };

  const register = (path, handler) => {
    try {
      disposers.push(ctx.webServer.register({ kind: "exact", path, handler }));
    } catch (e) {
      logger.warn?.(`注册路由 ${path} 失败：${e?.message || e}`);
    }
  };

  // 控制页
  register(`${BASE}/`, (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(renderPage());
  });

  // 状态
  register(`${BASE}/status`, (req, res) => {
    try {
      json(res, statusPayload());
    } catch (e) {
      json(res, { ok: false, error: String(e?.message || e) });
    }
  });

  // 一键打补丁
  register(`${BASE}/apply`, (req, res) => {
    let result;
    try {
      const asar = findAsar(null);
      if (!asar) throw new Error("没有找到 DeepSeek Harness 的 app.asar。");
      result = applyAsarPatch(asar);
      logger.info?.(`已打补丁：${asar}`);
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    if (result.ok === undefined) result.ok = !result.error;
    json(res, { ...result, status: safeStatus() });
  });

  // 还原
  register(`${BASE}/restore`, (req, res) => {
    let result;
    try {
      const asar = findAsar(null);
      if (!asar) throw new Error("没有找到 DeepSeek Harness 的 app.asar。");
      result = restoreAsar(asar);
      logger.info?.(`已还原：${asar}`);
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    if (result.ok === undefined) result.ok = !result.error;
    json(res, { ...result, status: safeStatus() });
  });

  return () => {
    for (const d of disposers) {
      try {
        d?.();
      } catch {}
    }
  };
}

function safeStatus() {
  try {
    return statusPayload();
  } catch {
    return null;
  }
}
