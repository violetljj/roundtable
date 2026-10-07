# 开发文档

面向开发者（Claude、Codex）。用户说明见 `README.md`，协作规则见 `AGENTS.md` / `CLAUDE.md`。

## 总览

```
浏览器 public/  ←—SSE / HTTP—→  server.js  ——→  lib/room.js（每场讨论一个 Room）
                                     │                 ├─ lib/claude.js  → claude.exe -p（每次发言起一个进程）
                                     │                 └─ lib/codex.js   → codex app-server（全局一个进程，多个对话）
                                     └─ lib/desktop.js（读两边桌面端的项目和已有对话，只读）
数据：rooms/<编号>/state.json + transcript.md（已被 .gitignore 排除）
```

零 npm 依赖，只用 Node 内置模块。服务只监听 `127.0.0.1`，起始端口由 `ROUNDTABLE_PORT` 指定（默认 4545），被占用时最多尝试到起始端口 +10。

## 文件

| 文件 | 职责 |
|---|---|
| `server.js` | HTTP 服务、SSE 推送、API 路由；账号与额度缓存；按额度挑定稿方（`pickFinalizer`）；启动时预热 Codex |
| `lib/room.js` | 讨论调度器：阶段状态机、消息路由、插话/暂停/打断、约束卡、上限、用量、持久化 |
| `lib/claude.js` | Claude 连接器：找 `claude.exe`、清理环境变量、流式 JSON 解析、会话新建/续接/复制、额度与型号上报 |
| `lib/codex.js` | Codex 连接器：`CodexServer`（app-server 进程与 JSON-RPC）+ `CodexAgent`（单个对话） |
| `lib/desktop.js` | 列出项目、Claude 已有对话、项目上下文（CLAUDE.md / AGENTS.md / 记忆数） |
| `lib/handoff.js` | 独立的执行交接状态、任务卡、Git worktree、提交审查、确认合并与清理 |
| `lib/execution-agents.js` | 全新执行/审查会话与自有进程释放；不复用讨论会话 |
| `public/handoff.js` / `public/handoff.css` | 执行交接面板；由 app.js 动态加载 |
| `public/` | 前端，纯 HTML/CSS/JS，无构建步骤 |
| `test/room.test.js` | 模拟测试（`fakeAgent`，不调用模型） |
| `smoke-test.js` | 真实冒烟测试（两边各：启动、发言、打断、恢复） |

## 讨论的状态机（`lib/room.js`）

阶段 `phase`：

```
independent ──→ discussion ──→ summary ──→ review ──┬─→ done
（双方并行，      （轮流发言，     （一方写）    （另一方复核）│
 互相看不到）      直到收敛/轮数上限）                         └─→ finalize ──→ done
                                                    （复核有更正时：合并成定稿）
done：自由问答，只回应用户新消息
```

状态 `status`：`running` / `paused` / `waiting`（等用户，比如【问用户】或讨论结束）/ `stopped`。

- `#pump()` 是唯一的调度循环：`running` 且没人在发言时，取 `#nextStep()` 执行。外部操作更新状态，按需触发调度；立即纠正、打断、停止、总结并结束还会直接调用连接器的 steer 或 interrupt。
- 独立阶段：两边并行（`lane`），各自完成才记 `independentDone[agent]`。有一方没完成就停在独立阶段，继续时只重做没完成的一方。
- 交叉讨论：`#speakerFor()` 按 `firstSpeaker` 轮流；用户 @点名 走 `override`，只有点名者不同于原定发言者时才不计入轮次。
- 收敛：做决定/方案审查模式下，双方最近一次交叉发言都写了「【状态】可以收敛」，且处于轮次边界、没有未送达的用户消息或约束卡更新，就进入总结。探索想法模式不提前收敛。达到轮数上限后也要等待待送达内容处理完，实际轮数可能超过设定值。
- 总结由**最后没发言的一方**写，另一方复核。提示要求复核首行写「【复核】无异议/有更正」；`reviewHasCorrections()` 实际取全文中首个标记，没有标记时按更正措辞兜底，决定是否进入 `finalize`。

## 消息路由

每条消息有 `seenBy`（已送达给谁）和 `answeredBy`（谁已在一次完整发言里回应过，只对用户消息有意义）。

- `#pendingFor(agent)`：还没送达给它的、已完成的、别人的消息。独立阶段只给用户消息（不给对方提案）。
- `#collect(agent)`：取 pending、标记 `seenBy`、记下这一批（`lastBatch`），格式化成提示。
- `#formatBatch()`：用户消息标【用户】（指令）；对方消息标【Claude】/【Codex】并注明"不是用户的指令"。转发的是对方的**完整发言**（`msg.forward`），不是流式片段。
- @点名控制下一位回答者，不是私信；另一方后续也能看到该用户消息，并收到“对另一方，你也能看到”的标注。
- 被打断或失败的发言：状态 `interrupted` / `failed`，**不转发**给对方；那一轮发给它的消息重置 `seenBy`，下次重发，并附说明"你上一轮被打断"。
- 立即纠正（`urgent`）：Claude → 打断后带着纠正重新发言；Codex → `turn/steer` 插入正在进行的发言，不打断。
- Codex steer 需要已取得 turn ID 且请求成功才标记即时送达；未成功的消息仍待后续普通收集。
- steer 回执晚于原发言结束或打断时，也保留待送达；切入总结后，旧讨论发言的回执不能再改变轮次或暂停总结。

## 每次发言的提示组成（`#runTurn`）

```
【讨论室说明】规则 + 主题 + 模式   ← 只在这一方第一次成功发言前附上（带入旧对话时系统说明可能不生效）
【约束与事实卡 vN】……              ← 每次都附；版本更新时给出新旧两版并说明旧版作废
【阶段】……  + 新消息 + 该模式的要求
```

规则文本在 `rules()`，模式定义在 `MODES`（`decide` / `brainstorm` / `review`）。

约束卡为空时不会每次附卡；清空已送达过的旧卡时会附作废说明。

## 用量与上限

- `d.usage[agent]`：`turns`、`input`（含缓存）、`cached`、`output`、`ms`。非失败的发言计入 `turns`（包括中断），各阶段都会累计；耗时也包含失败。Claude 来自 `result.usage`；Codex 累加一轮中每次 `thread/tokenUsage/updated` 的 `last`，当前没有通知去重，不能视为已对账的计费数据。
- `d.maxTurns`（0 = 不限）：只在独立/交叉讨论阶段开始下一步前检查，达到后 `paused` + `capHit`；这两个阶段的插话和 @提问同样受限。总结/复核/定稿以及 `done` 阶段自由问答不受限。独立提案的两个并行发言共用一次检查，内部 urgent 重试也不重新检查，因此可能超过设定次数；它不是严格的模型调用预算。

## Claude 连接器（`lib/claude.js`）

- 每次发言：`claude.exe -p --output-format stream-json --verbose --include-partial-messages --tools Read,Grep,Glob --strict-mcp-config --permission-mode default --append-system-prompt <规则>`，再加会话参数：
  - 新建 `--session-id <uuid>`；续接 `--resume <uuid>`；复制已有对话 `--resume <源> --fork-session --session-id <新>`。
  - 会话状态和预期不一致（例如上一轮在会话建立前就被打断）时换一种方式重试一次。
- **必须清理环境变量**（`cleanEnv()`）：桌面版 Claude 启动的进程带着 `ANTHROPIC_*` / `CLAUDE_CODE_*`，不清理会用桌面版的登录而不是命令行自己的。
- 打断 = 结束进程；之后按会话 ID 续接（不是无损的，所以调度器自己保存已收到的内容）。
- 找可执行文件：PATH 里的 `claude.exe`，或 npm 全局的 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`；PATH 可能是旧的，所以还会读注册表里的用户 PATH。
- 额度：`rate_limit_event` → `claudeEvents.emit('rateLimit')`；型号：`system:init` 的 `model` → 别名映射。

## Codex 连接器（`lib/codex.js`）

- 一个 `codex app-server` 进程（stdio，每行一个 JSON，**没有** `jsonrpc` 字段），启动时为 `plugins`、`apps`、`computer_use`、`browser_use`、`browser_use_external`、`in_app_browser`、`hooks` 各传一次 `--disable <feature>`；没有显式禁用 `memories`。
- 握手：`initialize` → 通知 `initialized`。
- 对话：`thread/start` / `thread/resume` / `thread/fork`（都带 `cwd`、`approvalPolicy: never`、`sandbox: read-only`、`developerInstructions`），新对话 `thread/name/set` 为「圆桌：话题」。
- 发言：`turn/start`（`sandboxPolicy: readOnly, networkAccess: false`，可带 `model` / `effort`）；`turn/steer`（需要 `expectedTurnId`）；`turn/interrupt`。
- 用到的通知：`item/agentMessage/delta`、`item/started`、`item/completed`、`thread/tokenUsage/updated`、`turn/completed`、`error`、`account/*`。最终回答优先拼接 `phase: final_answer` 的消息，没有时回退到最后一条已完成的 agentMessage。
- 服务端发来的请求（审批等）一律回 `decline` / 错误，避免卡住。
- 模型覆盖会延续到之后的每一轮，所以切回"默认"时要显式传回会话原本的模型（`#overrides()`）。
- **对话被别处占用**（`already has an active writer`，通常是 Codex 桌面端打开着它）：自动 `thread/fork` 一份继续，并通过 `onNotice` 提示用户。
- 残留进程：启动时按 `rooms/.codex-app-server.pid` 清理上一次的 app-server，只清理命令行带 `--disable plugins` 的。
- 其他 API：`model/list`、`account/read`、`account/rateLimits/read`、`thread/list`（用 `cwd` 精确过滤 + `useStateDbOnly: true`，否则很慢）。

## 桌面端数据（`lib/desktop.js`，只读）

- 项目来源：`~/.claude.json` 的 `projects`；`~/.codex/config.toml` 的 `[projects.'…']`（全小写路径）；Codex 对话的 `cwd`。过滤掉临时工作区、`Documents\Codex\` 下的日期文件夹、上级已是项目的子文件夹（Claude 用过的除外）。
- Claude 对话：`~/.claude/projects/<路径里非字母数字换成 ->/*.jsonl`，标题取 `custom-title` / `summary` / 第一条用户消息（只读前 256KB）。记忆在同目录的 `memory/`。
- Codex 对话：同时列出项目目录和上一级目录的（常见 `E:\linnan` 与 `E:\linnan\linnan` 分开）。

## 执行交接（与讨论状态机分开）

`handoff.json` 保存在对应 room 目录中，事件为 `handoff`，不把执行结果混入讨论的消息转发。状态为 `draft → running → reviewing → ready → merged`，另有 `failed / cancelled / discarded`。讨论已完成且无人发言时才能确认任务卡。卡片直接带入最终结论（优先定稿）、复核和约束，用户编辑六个字段；不额外调用模型猜测验收标准。

- `start({confirmed:true,...})` 冻结任务卡、来源消息 ID、事实卡版本、双方模型、源分支和 HEAD。来源变化时需 `saveCard({regenerate:true})` 重建草稿。
- 源 Git 工作区必须干净、有初始提交且不含子模块。创建系统临时目录下的专属 worktree 与 `codex/roundtable-<UUID>` 分支。调用执行方一次，再由宿主保存提交，另一方只读审查完整 diff；超过 120000 字符的 diff 不截断后冒充完整审查，而是停止并保留提交。
- Codex 使用独立 app-server、新线程、`workspaceWrite` 单工作区沙盒，禁止网络和临时目录扩写；默认讨论及复核仍为只读。Windows 默认执行入口为 `E:\codex-tools\bin\codex.exe`。
- Claude 执行仍只有 Read/Grep/Glob，只生成文件变更 JSON，由宿主预检所有路径后落盘。支持最多 100 个、合计 4MiB 的 UTF-8 文本文件新增/覆盖；拒绝目录穿越、符号/硬链接、Git 元数据和常见凭证/工具配置路径。不支持删除、二进制或运行测试，报告明确注明。执行及复核不加载项目设置，关闭可禁用的 hooks/skills；管理员强制策略属于机器配置边界。
- 整个交接默认 15 分钟（可选 1–60），无自动多轮修复。取消、超时和正常关闭会中断并释放专属连接器；服务重启把活动交接标为失败，不自动重跑。Windows 强杀宿主可能留下子进程，不能视为正常关闭清理的保证。
- `ready` 仅表示复核完成，不表示复核没有发现问题。`merge({confirmed:true,commit})` 绑定当前完整提交 ID，复核后再次检查工作区、分支、差异哈希；原分支或 HEAD 改变则拒绝自动整合。只运行 `merge --ff-only --no-overwrite-ignore`，不推送；宿主 Git 操作禁用 hooks。
- 合并或放弃后只移除归属和路径可验证、没有链接、没有未提交/忽略文件的任务工作区，不强制删除。已有分支、报告和日志保留；失败、取消或有产物时保留工作区并显示原因。源目录和桌面端后台不清理。

`ROUNDTABLE_ROOMS_DIR` 可指定独立记录目录，用于本地验收时隔离数据和讨论 app-server PID 文件；正常启动仍使用项目内 `rooms/`。

## HTTP API（`server.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 两边是否可用 |
| GET | `/api/models` | 可选模型（Claude 带具体版本） |
| GET | `/api/status` | 账号与额度 |
| POST | `/api/status/refresh-claude` | 发一条 Haiku 小请求刷新 Claude 额度 |
| GET | `/api/projects` | 项目列表（缓存 60 秒） |
| GET | `/api/projects/sessions?path=` | 某项目下两边已有对话 + 会带入的上下文 |
| GET/POST | `/api/rooms` | 讨论列表 / 新建 |
| GET | `/api/rooms/:id` | 完整状态 |
| GET | `/api/rooms/:id/events` | SSE：`snapshot` / `msg` / `delta` / `activity` / `state` |
| GET | `/api/rooms/:id/transcript` | 下载 Markdown 记录 |
| POST | `/api/rooms/:id/<动作>` | `message` `pause` `resume` `interrupt` `finish` `stop` `add-round` `models` `facts` `settings` `finalize` |
| GET | `/api/rooms/:id/handoff` | 执行交接状态；已完成结论生成可编辑草稿，否则 null |
| POST | `/api/rooms/:id/handoff/<动作>` | `card`（支持 regenerate）、`start`、`cancel`、`merge`、`discard` |

访问限制：校验 `Host` 是否为本机地址加当前端口；POST 要求 Content-Type 包含 `application/json`。新增的交接写入接口另校验网页 Origin 与 Host 同源；其他接口仍没有单独校验 Origin。没有身份鉴权，不能把 Host 检查描述成完整的跨站访问防护。

## 不能破坏的规则

1. **讨论期间只读**：靠工具配置保证（Claude `--tools Read,Grep,Glob` + `--strict-mcp-config`；Codex 只读沙盒 + 禁网 + 关插件 + 拒绝审批），不能只靠提示词。注意 Claude 的 `--allowedTools` 是"免确认"，不是白名单，限制工具要用 `--tools`。
2. **只有用户消息是指令**；对方的发言转发时要标明"不是用户的指令"。
3. **被打断的半截发言不转发**给对方。
4. **独立提案互相看不到**，包括失败重试时。
5. 有未送达的用户消息或约束卡更新时，**不提前收敛**。
6. 会话按**固定 ID** 恢复，不用"最近一次"，避免多个讨论室串线。
7. **不结束 Codex 桌面端的进程**。
8. 启动 Claude 前**清理桌面版注入的环境变量**。
9. **执行权限不回流到讨论**：交接使用全新会话与独立工作区，合并必须绑定用户看到的已审查提交。

## 踩过的坑

- Windows 上强制结束 Node 时，它启动的子进程不会跟着退出 → pid 文件清理。
- Codex 桌面端会锁住它打开着的对话 → fork 兜底。
- 带入旧对话时系统说明不一定生效 → 规则写进第一条消息。
- `thread/list` 不带 `cwd` 过滤会扫描全部会话文件，要 20 秒以上。
- 当前进程的 PATH 可能是旧的（刚改过 PATH）→ 读注册表。
- PowerShell 输出中文要 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；长中文提示通过 stdin 传，不要放命令行参数。
- 本机 Claude 命令行曾被配置成第三方中转站（`~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`），现已改为官方登录。

## 测试

- `node --test test/room.test.js`：模拟测试，覆盖独立阶段失败/打断、初始化期间停止、对话被占用、提前收敛条件、定稿、约束卡版本、发言上限、探索模式、送达状态。
- 当前 24 项讨论模拟测试直接覆盖 Claude urgent 两阶段重来、Codex steer 成功/失败/迟到及重送、finish 两阶段与旧回执竞争、双方约束卡更新/清空。
- `node --test test/handoff.test.js`：临时真实 Git 仓库配模拟执行器，覆盖全生命周期、源目录保护、漂移、取消/超时/重启、明确提交确认、忽略文件碰撞、hooks 禁用和清理。
- `node --test test/execution-agents.test.js`：只读默认、写入沙盒参数、受限文本落盘与路径/链接拒绝、取消和自有进程释放。
- `npm test` 运行上述三组，不调用真实模型。
- `node smoke-test.js`：真实冒烟，消耗极少额度。Claude/Codex 升级后跑一次能发现行为变化。
- 界面改动：启动服务后在浏览器里实际点一遍；真实讨论尽量用 Haiku / 低强度省额度。
