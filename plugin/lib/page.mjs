/**
 * page.mjs — 插件控制页（纯内联 HTML/CSS/JS，无需构建）。
 */

export function renderPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 窗口记忆</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #ffffff; --text: #1d2129; --muted: #6b7280;
    --border: #e5e7eb; --accent: #2563eb; --accent-text: #ffffff;
    --ok: #16a34a; --warn: #d97706; --err: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d; --card: #1e2128; --text: #e8eaed; --muted: #9aa0a6;
      --border: #333845; --accent: #3b82f6;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px; background: var(--bg); color: var(--text);
    font: 15px/1.6 "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 18px 20px; margin-bottom: 16px;
  }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .row .k { color: var(--muted); min-width: 96px; }
  .row .v { word-break: break-all; }
  .badge {
    display: inline-block; padding: 1px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
  }
  .badge.ok { background: rgba(22,163,74,.14); color: var(--ok); }
  .badge.no { background: rgba(220,38,38,.13); color: var(--err); }
  .btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  button {
    border: 1px solid var(--border); background: var(--card); color: var(--text);
    border-radius: 9px; padding: 9px 18px; font-size: 14px; cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button.primary:hover { filter: brightness(1.08); }
  button.danger { color: var(--err); }
  button:disabled { opacity: .5; cursor: default; }
  pre#log {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; font-size: 12.5px; line-height: 1.55; color: var(--muted);
    white-space: pre-wrap; word-break: break-all; min-height: 72px; margin: 0;
  }
  .hint { color: var(--muted); font-size: 13px; margin-top: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>DSH 窗口记忆</h1>
  <p class="sub">记录 DeepSeek Harness 桌面窗口的位置与大小，下次启动时自动恢复。打补丁后需重启桌面应用。</p>

  <div class="card" id="status">
    <div class="row"><span class="k">状态</span><span class="v" id="badge">加载中…</span></div>
    <div class="row"><span class="k">app.asar</span><span class="v" id="asarPath">—</span></div>
    <div class="row"><span class="k">窗口记录</span><span class="v" id="statePath">—</span></div>
    <div class="row"><span class="k">最近保存</span><span class="v" id="stateValue">—</span></div>
  </div>

  <div class="btns">
    <button class="primary" id="apply">打补丁</button>
    <button id="refresh">刷新状态</button>
    <button class="danger" id="restore">从备份还原</button>
  </div>

  <p class="hint" id="hint"></p>
  <pre id="log">就绪。</pre>
</div>

<script>
const $ = (id) => document.getElementById(id);
let busy = false;

function setLog(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent = '[' + t + '] ' + msg + '\n' + $('log').textContent;
}

function setBusy(v) {
  busy = v;
  for (const id of ['apply', 'restore', 'refresh']) $(id).disabled = v;
}

function render(s) {
  if (!s || s.ok === false) {
    $('badge').innerHTML = '<span class="badge no">不可用</span>';
    $('hint').textContent = s && s.error ? s.error : '读取状态失败。';
    return;
  }
  const a = s.asar || {};
  const patched = !!a.patched;
  $('badge').innerHTML = patched
    ? '<span class="badge ok">已打补丁</span>'
    : '<span class="badge no">未打补丁</span>';
  $('asarPath').textContent = a.path || '未找到 app.asar';
  const st = s.stateFile || {};
  $('statePath').textContent = st.exists
    ? st.path
    : '还没有记录（打补丁并拖动窗口后生成）';
  $('stateValue').textContent =
    st.exists && st.value
      ? JSON.stringify(st.value)
      : '—';
  $('hint').textContent = s.hint || '';
}

async function refresh() {
  if (busy) return;
  try {
    const r = await fetch('status', { cache: 'no-store' });
    const s = await r.json();
    render(s);
  } catch (e) {
    setLog('刷新失败：' + (e && e.message ? e.message : e));
  }
}

async function call(path) {
  if (busy) return;
  setBusy(true);
  setLog('正在' + (path === 'apply' ? '打补丁' : '还原') + '…');
  try {
    const r = await fetch(path, { method: 'POST' });
    const s = await r.json();
    if (s.ok === false) {
      setLog('失败：' + (s.error || '未知错误'));
    } else {
      setLog(s.message || '完成');
    }
    render(s.status || s);
  } catch (e) {
    setLog('失败：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
}

$('apply').addEventListener('click', () => call('apply'));
$('restore').addEventListener('click', () => call('restore'));
$('refresh').addEventListener('click', refresh);
refresh();
</script>
</body>
</html>`;
}
