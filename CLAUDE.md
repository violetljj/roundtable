# 协作说明（Claude 与 Codex 共用）

这个项目由 **Claude**（Claude Code）和 **Codex** 共同开发，用户是 Junjie Lai。
`AGENTS.md`（Codex 读）和 `CLAUDE.md`（Claude 读）内容一致，改一份时同步另一份。

项目：Claude × Codex 圆桌讨论室——本地网页，两边实时讨论，用户随时插话。面向用户的说明见 `README.md`。

## 开始工作前

1. 读 `docs/DEVLOG.md` **最后几条**，了解对方刚做了什么、还有什么没收尾。
2. 读 `docs/ARCHITECTURE.md` 里和这次改动相关的部分，尤其是「不能破坏的规则」。
3. 运行 `git status`。如果有不是你改的未提交改动，那是对方（或用户）正在进行的工作：**不要覆盖、回退或顺手整理它们**；要改同一个文件时先问用户。

## 完成一项工作后

1. 跑模拟测试：`node --test test/room.test.js`（不调用真实模型，几秒钟）。改了 `lib/claude.js` 或 `lib/codex.js` 时，再跑真实冒烟测试 `node smoke-test.js`（消耗极少额度）。
2. 在 `docs/DEVLOG.md` **末尾追加**一条记录（格式见那份文件开头）。如实写：验证了什么、没验证什么、留下了什么问题。
3. 涉及结构、协议或规则的变化，同步更新 `docs/ARCHITECTURE.md`；做了取舍的决定记到 `docs/ROADMAP.md` 的「决定记录」。
4. 用户可见的变化更新 `README.md`。
5. 按下面的「提交与推送」自动提交并推送。

## 提交与推送（自动）

用户已授权：**每完成一项工作，测试通过后自动提交并推送**，不用再问。步骤：

1. 确认 `node --test test/room.test.js` 全部通过（改了连接器还要跑过 `node smoke-test.js`）。**测试不过不提交**，先修或告诉用户。
2. `git status` 检查：**只提交自己这次的改动**（包括 `docs/DEVLOG.md` 里自己新加的那条）。有不是你改的未提交改动，那是对方正在进行的工作，不要把它一起提交；用 `git add <具体文件>`，不要 `git add -A`。
3. 提交信息用英文祈使句，第一行概括改动（例如 `Add task card handoff`），正文可以写要点；末尾加作者行：Claude 写 `Co-Authored-By: Claude <noreply@anthropic.com>`，Codex 写 `Co-Authored-By: Codex <noreply@openai.com>`。
4. 推送前先 `git pull --rebase origin main`，合并对方已推送的提交，然后 `git push origin main`。
5. **遇到冲突、rebase 失败或推送被拒，就停下来告诉用户**，不要自己解决冲突后强推。**绝不使用 `--force` / `--force-with-lease`**，不改写已推送的历史。

始终不要提交：`rooms/`（讨论记录，含项目内容）、凭证、本机配置。`.gitignore` 已经排除了它们，提交前再看一眼暂存的文件列表。

## 约定

- 界面文字、文档、代码注释用中文；注释简洁，写"为什么"而不是复述代码。
- 不引入 npm 依赖（目前零依赖，只用 Node 内置模块），除非先和用户确认。
- 改动讨论流程后，要能用模拟测试复现的，就补一个测试（参照 `test/room.test.js` 里的 `fakeAgent`）。
- 本机环境：Windows；Node 在 `E:\codex-tools\tools\nodejs\node.exe`；开发服务器 `node server.js`，端口 4545。
- **不要结束 Codex 桌面端的后台进程**。讨论室只清理自己启动的那个（命令行带 `--disable plugins`）。
