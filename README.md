# dsh-window-state

让 **DeepSeek Harness 桌面窗口记住关闭前的位置和大小**，下次启动自动按上次的位置打开。

> 一个小补丁：修改 DSH 安装目录里的 `resources/app.asar`，在窗口创建时读取上次保存的窗口位置，并在拖动 / 缩放 / 最大化 / 关闭时自动保存。
>
> 提供两种形态：**命令行补丁工具**（`bin/patch.mjs`）和 **DSH 插件**（[`plugin/`](plugin/README.md)，带浏览器控制页）。

## 效果

- 关闭（到托盘）或彻底退出后重新打开，窗口回到上次的位置和大小；
- 最大化状态也会被记住，下次启动直接最大化；
- 窗口被移到屏幕外（比如拔掉副屏）时自动回落到默认位置，不会“丢窗口”。

## 原理

DSH 桌面版基于 Electron，主进程入口在打包文件 `resources/app.asar` 内。Electron 的 `EnableEmbeddedAsarIntegrityValidation` fuse 在这版构建里是关闭的，所以可以安全地修改 asar 内的 `lib/main.js`：

1. 在 `createWindow()` 里读取 `<userData>/window-state.json`，有记录就用它作为初始位置/大小；
2. 监听 `resize` / `move` / `maximize` / `unmaximize` / `close` / `hide`，把窗口位置保存到同一个 JSON 文件；
3. 修改后的 `main.js` 追加写回 asar 末尾，并更新 asar 头部里对应文件条目的 `offset` / `size`（`offset` 必须是字符串，否则 Electron 找不到入口）。

窗口状态文件位置（Windows）：

```
%APPDATA%\@deepseek-ai\dsh-desktop\window-state.json
```

## 使用

### 方式一：命令行工具

需要 Node.js >= 18。

```bash
# 自动探测常见安装路径并打补丁
node bin/patch.mjs

# 手动指定 app.asar
node bin/patch.mjs "F:\DeepSeek Harness\resources\app.asar"

# 只检查能否打补丁（不写文件）
node bin/patch.mjs --dry-run

# 用最近的备份还原
node bin/patch.mjs --restore
```

打补丁前会自动生成备份 `app.asar.bak-<时间戳>`，可以用 `--restore` 还原，也可以手动把备份复制回 `app.asar`。

打完后**重启 DeepSeek Harness**生效。之后拖动窗口停 1 秒以上，状态就会保存。

### 方式二：DSH 插件（推荐）

`plugin/` 是一个 DSH host 插件，安装后提供浏览器控制页：查看补丁状态、一键打补丁、一键还原备份。

安装步骤见 [plugin/README.md](plugin/README.md)。简单说：

1. 把 `plugin/` 复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-window-state\`；
2. 在 profile 的 `package.json` 里把 `dsh-window-state` 加入 `dependencies` 和 `dsh.profile.bundles`；
3. 重启 DSH，打开 `http://127.0.0.1:<Web GUI 端口>/dsh-window-state/`，点「打补丁」再重启一次。

## 注意

- **DSH 升级 / 重装会用新的 `app.asar` 覆盖补丁**，升级后重新运行一次本脚本即可。
- 这是非官方补丁，修改的是应用资源文件，请自行评估风险；脚本在锚点不匹配时会直接报错退出，不会写入半成品。
- 补丁基于 `dsh-desktop 0.2.1-rc.2` 的 `lib/main.js` 结构编写；不同版本的代码结构如果变化，`--dry-run` 会告诉你锚点匹配失败。
- 窗口大小下限是 DSH 自己的 `minWidth: 520 / minHeight: 600`，不会比这更小。

## English

A tiny patch that makes the DeepSeek Harness desktop window remember its position and size across restarts. It edits `resources/app.asar` → `lib/main.js` (safe because the Electron `EnableEmbeddedAsarIntegrityValidation` fuse is off in this build), saving bounds to `<userData>/window-state.json`.

```bash
node bin/patch.mjs "C:\path\to\resources\app.asar"
node bin/patch.mjs --dry-run
node bin/patch.mjs --restore
```

Requires Node.js >= 18. Re-run after every DSH update.

## License

MIT
