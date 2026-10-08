# 协作说明（Codex 与 Claude 共用）

这个项目由 **Claude**（Claude Code）和 **Codex** 共同开发，用户是 Junjie Lai。
`AGENTS.md`（Codex 读）和 `CLAUDE.md`（Claude 读）内容一致，改一份时同步另一份。

项目：Claude × Codex 圆桌讨论室——本地网页，两边实时讨论，用户随时插话。面向用户的说明见 `README.md`。

## 开始工作前

1. 读 `docs/DEVLOG.md` **最后几条**，了解对方刚做了什么、还有什么没收尾。
2. 读 `docs/ARCHITECTURE.md` 里和这次改动相关的部分，尤其是「不能破坏的规则」。
3. 运行 `git status`。如果有不是你改的未提交改动，那是对方（或用户）正在进行的工作：**不要覆盖、回退或顺手整理它们**；要改同一个文件时先问用户。
4. 修改前用 `node scripts/claims.js list` 查看认领，再用 `claim --owner <你的任务名> --task "任务说明" --minutes 60 <文件...>` 原子认领本次文件，保存返回的 token。完成、取消或交接时按 owner 和 token 释放；超过预计时间只提示可能失联，不自动抢占。认领不能替代第 3 条，也不能阻止绕过工具编辑。完整命令见 [docs/FILE_CLAIMS.md](docs/FILE_CLAIMS.md)。

## 完成一项工作后

1. 按下方「适度验证与实现」选择与改动直接相关的检查。讨论流程改动运行相关模拟测试。连接器改动按影响面选：改到冒烟测试覆盖的路径（进程启动与握手、流式解析、打断、按 ID 恢复会话）或 Claude/Codex 升级后，跑 `node smoke-test.js`；只改了启动参数、工具权限或新增能力，就对改动的那条路径做一次针对性的真实调用（例如确认该放行的放行、该拒绝的拒绝），不必再跑整套冒烟。纯文档改动只核对内容与差异。
2. 在 `docs/DEVLOG.md` **末尾追加**一条记录（格式见那份文件开头）。如实写：验证了什么、没验证什么、留下了什么问题。
3. 涉及结构、协议或规则的变化，同步更新 `docs/ARCHITECTURE.md`；做了取舍的决定记到 `docs/ROADMAP.md` 的「决定记录」。
4. 用户可见的变化更新 `README.md`。
5. 按下面的「提交与推送」自动提交并推送。

## 提交与推送（自动）

用户已授权：**每完成一项工作，相关验证通过后自动提交并推送**，不用再问。步骤：

1. 确认本次适用的检查通过；纯文档不要求运行代码测试。**相关检查不过不提交**，先修或告诉用户。
2. `git status` 检查：**只提交自己这次的改动**（包括 `docs/DEVLOG.md` 里自己新加的那条）。有不是你改的未提交改动，那是对方正在进行的工作，不要把它一起提交；用 `git add <具体文件>`，不要 `git add -A`。
3. 提交信息用英文祈使句，第一行概括改动（例如 `Add task card handoff`），正文可以写要点；末尾加作者行：Claude 写 `Co-Authored-By: Claude <noreply@anthropic.com>`，Codex 写 `Co-Authored-By: Codex <noreply@openai.com>`。
4. 推送前先 `git fetch origin`。我们共用同一个工作目录，对方常有未提交的改动，这时 `git pull --rebase` 会拒绝执行，**不要用 `--autostash` 或 `git stash` 动对方的改动**：
   - 远端没有新提交（`git merge-base --is-ancestor origin/main HEAD` 成立）：直接 `git push origin main`，这是快进推送，不会覆盖任何东西。
   - 远端有新提交：工作区干净时 `git pull --rebase origin main` 再推送；工作区不干净就停下来告诉用户。
   - 只提交对方没碰过的部分时，可以用 `git diff <文件>` 生成补丁、去掉对方的片段后 `git apply --cached`，提交前用 `git diff --cached` 确认暂存区里只有自己的改动。
5. **遇到冲突、rebase 失败或推送被拒，就停下来告诉用户**，不要自己解决冲突后强推。**绝不使用 `--force` / `--force-with-lease`**，不改写已推送的历史。

始终不要提交：`rooms/`（讨论记录，含项目内容）、凭证、本机配置。`.gitignore` 已经排除了它们，提交前再看一眼暂存的文件列表。

## 适度验证与实现

- 减少不必要的测试和防御性编程：默认只做覆盖本次改动的最小必要验证，不动辄全量测试，不反复运行已通过且未受后续改动影响的检查。仅在跨模块影响、实际失败或明确验收要求下扩大范围；纯文档、文案或样式改动采用相应的内容核对或局部查看。实现以当前需求和已知输入契约为准，不为假想场景堆叠兜底、重试、冗余校验或抽象；保留真实外部边界、权限和数据完整性所需的保护。

## 约定

- 界面文字、文档、代码注释用中文；注释简洁，写"为什么"而不是复述代码。
- 不引入 npm 依赖（目前零依赖，只用 Node 内置模块），除非先和用户确认。
- 改动讨论流程后，要能用模拟测试复现的，就补一个测试（参照 `test/room.test.js` 里的 `fakeAgent`）。
- 本机环境：Windows；Node 在 `E:\codex-tools\tools\nodejs\node.exe`；开发服务器 `node server.js`，端口 4545。
- 同一个讨论记录目录（默认 `rooms/`）只能跑一份服务，启动时会按 `rooms/.server.json` 自动检查，已有就直接打开它。验收需要起服务时：用户那份在跑就用它；要独立的临时服务，必须同时设 `ROUNDTABLE_ROOMS_DIR`（临时目录）和 `ROUNDTABLE_PORT`，用完结束进程并清理该目录。
- **不要结束 Codex 桌面端的后台进程**。讨论室只清理自己启动的那个（命令行带 `--disable plugins`）。
