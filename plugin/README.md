# dsh-window-state

让 **DeepSeek Harness 桌面窗口**记住关闭前的位置和大小，下次启动时恢复到上次的样子。

这是一个 DSH 插件（host 侧），提供本地控制页与 JSON API，负责给桌面应用的 `app.asar` 打一个轻量补丁。

---

## 功能

- **一键打补丁**：给 `resources/app.asar` 里的 `lib/main.js` 注入窗口状态读写逻辑（自动备份原版）。
- **状态查看**：显示 asar 是否已打补丁、窗口状态文件的位置与内容。
- **一键还原**：从最近的 `app.asar.bak-*` 备份恢复。
- **控制页**：浏览器直接打开，无需界面插件。

打补丁后，窗口在拖动 / 缩放 / 最大化 / 关闭时自动保存位置与大小，下次启动按上次的 bounds 打开；若上次是最大化，会恢复最大化。保存在屏幕外的窗口会自动回退到默认位置。

## 安装

> 本插件需要和桌面版的 `app.asar` 在同一个用户下运行，因此请装在 **desktop profile** 里。

1. 把本目录（`plugin/`）复制到 DSH 的 desktop profile：

   ```text
   %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-window-state\
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   - `dependencies` 里加一项：

     ```json
     "dsh-window-state": "file:./node_modules/dsh-window-state"
     ```

     （或者复制到 node_modules 后，加 `"dsh-window-state": "0.1.0"` 也可以。）
   - `dsh.profile.bundles` 数组里加一项：

     ```json
     "dsh-window-state"
     ```

3. 重启 DeepSeek Harness。

4. 打开浏览器，访问你的 DSH Web GUI 地址并加上路径：

   ```text
   http://127.0.0.1:<Web GUI 端口>/dsh-window-state/
   ```

   点 **打补丁** → 再重启一次 DeepSeek Harness → 完成。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-window-state/` | 控制页 |
| GET | `/dsh-window-state/status` | 状态（asar 路径、是否已打补丁、窗口状态文件） |
| POST | `/dsh-window-state/apply` | 打补丁（自动备份） |
| POST | `/dsh-window-state/restore` | 从最近备份还原 |

## 注意

- 打补丁会修改 `app.asar`，**升级 / 重装应用后补丁会被覆盖**，重新打开控制页点一次即可。
- 打补丁前默认自动备份为 `app.asar.bak-<时间戳>`；还原按钮会使用最新的备份。
- 补丁只处理桌面版当前版本的 `lib/main.js` 结构；如升级后结构变化，打补丁会明确报错（不会写坏文件）。
- 不能同时使用本插件和其他直接改 `app.asar` 的工具（会互相覆盖）。
- 如果控制页显示「未找到 app.asar」，可设置环境变量 `DSH_ASAR` 指向 asar 路径。

## License

MIT © 2026 dsh-window-state contributors
