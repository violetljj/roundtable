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
| `lib/behavior-cards.js` / `public/behavior-cards.js` | 双边行为卡：预设、默认值继承、精确型号匹配（含 Claude 别名解析）、提示更新与就地增删改 |
| `lib/discussion-quality.js` / `lib/discussion-api.js` | 讨论质量和双版结论协议、扩展模式、已复核结果提取与实验 API 调度 |
| `lib/experiment.js` / `public/experiment-panel.js` | 独立小实验生命周期、批准卡、证据回流和面板 |
| `lib/roundtable-client.js` / `scripts/roundtable.js` | 外部对话创建圆桌、有限等待、取得结果；技能入口在 `skills/roundtable` |
| `lib/claude.js` | Claude 连接器：找 `claude.exe`、清理环境变量、流式 JSON 解析、会话新建/续接/复制、额度与型号上报 |
| `lib/codex.js` | Codex 连接器：`CodexServer`（app-server 进程与 JSON-RPC）+ `CodexAgent`（单个对话） |
| `lib/discussion-tools.js` / `public/discussion-tools.js` | 讨论能力（全局）：联网、Claude 只读命令、Claude Docs 只读、Codex 插件；拼装两边的启动参数 |
| `lib/desktop.js` | 列出项目、Claude 已有对话、项目上下文（CLAUDE.md / AGENTS.md / 记忆数） |
| `lib/handoff.js` | 独立的执行交接状态、任务卡、Git worktree、提交审查、确认合并与清理 |
| `lib/execution-agents.js` | 全新执行/审查会话与自有进程释放；不复用讨论会话 |
| `public/handoff.js` / `public/handoff.css` | 执行交接面板；由 app.js 动态加载 |
| `public/` | 前端，纯 HTML/CSS/JS，无构建步骤 |
| `public/render-queue.js` | 按消息 ID 合帧；切房间和快照重建时取消旧帧 |
| `lib/status-cache.js` | 账号后台刷新、并发合并、成功缓存和失败退避 |
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
- 实验回传的固定请求沿用用户消息的送达路由，但有 `origin:experiment-return` 和 `experimentId`；页面、导出与提示明确显示为讨论室自动请求，由用户按钮操作触发。旧记录用已有的 `from:user + experimentId` 识别，不重写历史正文。
- @点名控制下一位回答者，不是私信；另一方后续也能看到该用户消息，并收到“对另一方，你也能看到”的标注。
- 被打断或失败的发言：状态 `interrupted` / `failed`，**不转发**给对方；那一轮发给它的消息重置 `seenBy`，下次重发，并附说明"你上一轮被打断"。
- 立即纠正（`urgent`）：Claude → 打断后带着纠正重新发言；Codex → `turn/steer` 插入正在进行的发言，不打断。
- Codex steer 需要已取得 turn ID 且请求成功才标记即时送达；未成功的消息仍待后续普通收集。
- steer 回执晚于原发言结束或打断时，也保留待送达；切入总结后，旧讨论发言的回执不能再改变轮次或暂停总结。

## 结论之后继续

`done` 阶段用户发消息走 `#freeTurn`（自由问答），不改结论。`conclusionFromRoom()` 返回 `newSince`：最近一份定稿（没有定稿时为复核）之后、`phase === 'done'` 的完整模型发言数；界面据此提示"尚未纳入结论"，空闲时的提示文案也按它区分。两条路回到正式流程：`reopen(rounds=1)` 从 `done` 回到 `discussion`，把 `maxRounds` 设到当前轮次往后 `rounds` 轮、清空收敛标记，讨论满轮后照常总结→复核（→定稿）；`resummarize()` 直接 `#enterSummary`。两者都只在 `done` 且无人发言时可用，接口 `POST /api/rooms/:id/reopen|resummarize`，小实验运行中同样被拦截。重开期间已有讨论消息在旧总结之后，旧结论按原规则不可交付，直到新的复核完成。

## 显示名与引导下一轮

`Room.rename(title)` 只写 `d.title`（最多 80 字，清空或等于议题时删除），`summary()` 带出供侧栏使用；接口 `POST /api/rooms/:id/rename`。模型提示始终用 `d.topic`，显示名不发给双方。「引导下一轮」是纯前端预填：三条固定文字以【只针对下一轮】开头，由用户编辑后按普通消息发送，不存设置、不进行为卡。

## 双边行为卡

`d.behaviorCards` 保存本场总开关、版本和卡片。卡片含 ID、标题、subject、`kind`（strength／weakness）、精确 modelIds、场景标签（engineering／creative／general，只给人辨认，不参与匹配）、单卡开关和一句 `text` 提醒；来源始终为「用户经验，尚未验证」。旧记录里的 `scene` 字段载入时丢弃；旧卡的 trigger/action 合成 `text`，没有 kind 的按短处处理。不读取历史纠正自动形成模型画像。

`behaviorCardsFor()` 按总开关、单卡开关、`text` 非空和目标方当前型号筛选；何时执行由卡片自己的触发条件决定，不再要求每场预选场景（曾有的本场场景选择与触发条件重复，混合任务只能二选一）。型号比较用 `effectiveModelId()`：Claude 别名和命令行默认经 `resolveClaudeAlias()` 换成命令行实际报告的完整 ID，Codex 用原值；未知型号不推断。`snapshot()` 附带 `behaviorActive`（生效卡 ID）和 `behaviorModelIds`，前端不重复实现解析。双方看到同样的卡，角色按 kind 区分（`ROLES`）：短处卡目标方出现对应情况时照做，被指出时先核对原话、属实就承认改正；另一方看到对方确实出现时直接指出（引用原话、说明对应哪一点及怎么改），没出现不提——只"知道"不点明，被提醒方容易辩护到底；长处卡目标方主动多承担，另一方遇到这类问题先请对方出方案或重点参考其意见、保留自己的判断。默认四张卡一长一短各一对；不转发对方独立提案，也不改变主笔、连接器或执行权限。注入文字明确这是"可能倾向的提醒，不代表一定存在"，不要据此给对方下结论或矫枉过正。

**默认值继承**：`<roomsDir>/.behavior-cards.json` 保存最近一次修改的 `{ enabled, cards }`。`POST /api/rooms/:id/settings` 带 `behaviorCards` 时、新建请求明确给出 `behaviorCards.enabled` 时写入；新建时未给出的部分由 `inheritBehaviorCards()` 从中补齐（API/命令行入口不传则沿用开关与卡片）。每场讨论保存自己的副本。`GET /api/behavior-cards` 返回 `{ defaults, presets, modelChoices }`：预设 `BEHAVIOR_PRESETS` 是常见长短处的起点（`note` 只在界面显示，不发给模型），`modelChoices` 给编辑时点选的完整型号 ID。

复用 `POST /api/rooms/:id/settings` 的 `behaviorCards` 字段保存整套设置，语义变化时版本 +1。`#runTurn` 在调用前冻结本次 active 卡及型号，保存到模型消息的 `behaviorCards`；发言旁的版本标签和悬停提示使用此快照，避免把新设置套到旧发言上。初次启用、内容/生效型号变化时按签名注入更新块，停用或失配发送旧卡作废说明。行为卡不放入不可更新的系统提示，原质量规则仍只发一次。

`behaviorCardsSeen` 只在完整结束后记录签名；注入前持久化 `behaviorCardsDirty`，失败、中断或重启仍待重送，撤销也覆盖已尝试注入的提示。进行中修改不打断当前发言，下次生效；双方未收到当前签名或仍 dirty 时不提前结束交叉讨论，旧卡、旧版本或旧型号下的完成不能恢复已清空的收敛标记。卡片只给提示，模拟流程通过不代表模型真实遵从或质量提升。

## 单实例

同一个讨论记录目录只跑一份服务（`lib/instance-lock.js`）。两份会同时写 `rooms/`，后启动的一份还会按 `.codex-app-server.pid` 把前一份的 Codex app-server 当残留进程清理掉。启动时在创建 Codex 后台之前调用 `claimInstance`：`rooms/.server.json` 记着占用者 PID 和端口，占用者存活且 `/api/health` 应答就打开它并退出；刚启动还没写端口时最多等 15 秒；进程已不在或一直不应答（PID 被复用）按失效接管；锁文件用 `wx` 原子创建，同时启动只有一份成功。没有锁文件时还会在 4545–4555 里探测旧版服务。监听成功后写入实际端口，正常退出（含 Windows 关窗口的 SIGHUP）删除自己的锁；强杀留下的锁下次启动接管。`scripts/roundtable.js` 没给 `--url` 时读锁文件里的端口。

应用窗口模式（`node server.js --app`，启动脚本用，`lib/app-window.js`）：前台进程把自己以 `--app --background` 重新启动为隐藏的后台进程（输出写 `rooms/.server.log`），等锁文件里的 PID 应答 `/api/health` 后退出，命令行窗口随之关闭；后台启动失败或 60 秒未就绪就打印日志、返回 1 让启动脚本停住。后台进程监听后用 Chrome `--app` 和独立配置目录 `rooms/.app-window` 打开窗口；已有服务时只再开一个窗口。窗口是否开着按页面连接判断：`public/app-window.js` 在 `/api/app-mode` 为真时常开 `/api/presence`，连接数归零 5 秒后（容许刷新）执行 `shutdown()`；页面从未连上而浏览器进程退出，或 2 分钟内没连上，也停止。`shutdown()` 先把各讨论延迟的写盘落盘。只用 Chrome：Edge 新建配置会自动登录 Windows 微软账号、同步浏览记录并打开额外窗口（实测）。找不到 Chrome 时 `--app` 退回前台运行加默认浏览器。

## 每次发言的提示组成（`#runTurn`）

```
【讨论室说明】规则 + 主题 + 模式   ← 只在这一方第一次成功发言前附上（带入旧对话时系统说明可能不生效）
【约束与事实卡 vN】……              ← 每次都附；版本更新时给出新旧两版并说明旧版作废
【双边行为卡 vN】……                ← 首次启用或生效内容/型号变化时附；停用明确撤销，失败/中断重送
【阶段】……  + 新消息 + 该模式的要求
```

规则文本在 `rules()`，模式定义在 `MODES`（`decide` / `brainstorm` / `review` / `paper` / `learn`）。论文模式先双独立审稿，再核对批评和作者回应；讲课模式由 `firstSpeaker` 讲解，另一方追问。

**规则只发一次**：讨论质量规则（`QUALITY_RULES`：反驳先定位原话、检查最脆弱假设、事实分歧转查证）和可选的主张格式都写在 `rules()` 里，随开场说明发一次，同时作为系统提示保留（Claude 每次 `--append-system-prompt`，Codex 线程的 `developerInstructions`），不再附在每轮消息末尾。每轮通常只带阶段说明、新消息和约束卡；行为卡首次启用或生效内容变化时另附更新块。主张格式（`CLAIM_PROTOCOL`）只在 `d.claimCards` 为真时写进规则，新建时默认关闭；旧讨论没有该字段，视为关闭，已有发言里的【主张】仍会被提取。这些是提示协议，不是质量保证。

总结固定 `## 三句话版`、`## 完整版` 和 `## 推进版`，各模式总结项目置于完整版三级标题下；推进版写给没看过讨论的执行方（目标、已定决定、步骤、约束、验收、先问用户），只整理讨论已有内容。复核和更正同时覆盖三版。`splitConclusion()` 返回 `brief / full / next`，旧结论没有推进版时 `next` 为空。`conclusionFromRoom()` 只返回 done 阶段最新完整总结/复核对应的结果；有更正时等完整定稿。新总结、失败复核、未处理实验和重新讨论会使旧定稿失效。旧总结无双版标题时短版为空，不臆造摘要。

复核调度与结果提取共用 `reviewVerdict()`：首个非空行的完整复核标记优先；无标记时仅兼容明确确认和更正措辞，不采用引用或示例中的标记。返回 `accepted / corrections / unknown`；含混复核保留 review 阶段并暂停，点继续重新复核，不能宣布总结通过。`reviewHasCorrections()` 仅为旧调用的兼容包装。

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

## 前端工作区与信息层级

`public/workspace-ui.js` 管理「讨论 / 结论」视图、三阶段进度与本场设置抽屉；样式统一在 `style.css`（原 `workspace.css` 已并入）。页面分工：顶部只放标题、模式、进度和视图切换；输入框上方的状态条（`#statusDock`）集中显示谁在发言、暂停/上限/出错原因（`#notice`）、阶段细节（`#phasePill`）和当下可用的控制按钮，`data-state` 与 `.alert` 决定配色；本场设置是右侧抽屉，约束卡内容、模型、用量直接显示为可点的行。独立提案两栏完成后超过约 340px 的一方折叠，展开状态按消息 ID 记在前端内存。时间线仍是原消息滚动容器，流式渲染与讨论调度不变。切换结论时暂时隐藏输入区和状态条，回到讨论恢复；核查定位与总结定位先切回讨论并关闭抽屉。约束卡、模型、用量三项在抽屉内就地编辑（`.tool-section.editing` 切换预览与表单），原来的三个独立对话框已删除；实验、交接、主张详情打开前先关抽屉，任何时候只有一层窗口。独立提案并排卡片在流式输出时就固定最大高度、内部滚动跟随（`.bubble.live`），完成后改为折叠（`.bubble.folded`），两种状态高度相同，页面不跳动。标题、结论正文用衬线体（`--serif`，Windows 11 自带 Noto Serif SC），正文用无衬线体；`claim-board.css`、`experiment-panel.css`、`handoff.css` 只用 `style.css` 的变量，焦点框用墨色，绿色只表示进行中/已完成。

结论按需读取 `/result`，只在可见且相关状态变化时更新；用讨论 ID、请求代次及消息签名拒绝过时回包。复制集中在结论页，以服务端 `ready` 为准；旧记录缺少短版时仅显示完整内容。实验/执行仍使用原独立面板与批准流程，入口收进「本场设置」抽屉，待处理状态通过入口提示保留可见性。主张清单挂载到本场设置抽屉，不再常驻消息上方。

新建表单保留原字段和提交协议，将上下文与高级设置折叠。新讨论默认使用 `claude-opus-5-5 / high` 与 `gpt-6-astra / high`，`Room.create` 同时为 API/命令行补齐未指定的一方；显式配置（包括空值跟随设置）优先，旧讨论读取沿用原设置。窗口立即打开，模型列表查询共用在途请求；当前固定型号即使不在目录中也补入选择器，目录读取失败时保留默认型号和 high，未渲染时提交同一组默认值。侧栏记录和视图页签支持键盘操作。

## 界面刷新与账号缓存

- `app.js` 以 ES 模块加载。流式增量按消息 ID 合并，每帧只安排一次回调；完成事件替换对象时使用当前消息，切房间和快照重建时取消旧帧。仍会解析当前消息的完整 Markdown，未实现长历史虚拟列表。
- `/api/status` 不等待命令行或 RPC；每方返回 `refreshing`、`updatedAt`（上次成功查询的毫秒时间或 null）与 `error`。Claude 账号缓存 60 秒、Codex 账号与额度缓存 30 秒，从查询完成时计时。服务启动预热，同一方同时只查询一次；失败保留缓存并退避 15 秒，手动刷新绕过缓存期和退避但复用在途查询。
- Claude 查询返回的错误对象转成刷新失败；Codex 状态查询直接保留 RPC 错误，避免旧 `account()` 的 null 兜底把故障当成未登录。额度事件仍能即时更新，Claude 额度只由模型发言或用户确认的小请求更新。
- 网页只在后台查询未完成时按 1、2、4、5 秒间隔补读状态；页面隐藏时停止这段补读，恢复可见时重新读取。原每分钟状态轮询保留。

## 桌面端数据（`lib/desktop.js`，只读）

- 项目来源：`~/.claude.json` 的 `projects`；`~/.codex/config.toml` 的 `[projects.'…']`（全小写路径）；Codex 对话的 `cwd`。过滤掉临时工作区、`Documents\Codex\` 下的日期文件夹、上级已是项目的子文件夹（Claude 用过的除外）。
- Claude 对话：`~/.claude/projects/<路径里非字母数字换成 ->/*.jsonl`，标题取 `custom-title` / `summary` / 第一条用户消息（只读前 256KB）。记忆在同目录的 `memory/`。
- Codex 对话：同时列出项目目录和上一级目录的（常见 `E:\linnan` 与 `E:\linnan\linnan` 分开）。

## 执行交接（与讨论状态机分开）

`handoff.json` 保存在对应 room 目录中，事件为 `handoff`，不把执行结果混入讨论的消息转发。状态为 `draft → running → reviewing → ready → merged`，另有 `failed / cancelled / discarded`。讨论已完成且无人发言时才能确认任务卡。卡片直接带入最终结论（优先定稿；有推进版时方案只取推进版）、复核和约束，用户编辑六个字段；不额外调用模型猜测验收标准。

- `start({confirmed:true,...})` 冻结任务卡、来源消息 ID、事实卡版本、双方模型、源分支和 HEAD。来源变化时需 `saveCard({regenerate:true})` 重建草稿。
- 源 Git 工作区必须干净、有初始提交且不含子模块。创建系统临时目录下的专属 worktree 与 `codex/roundtable-<UUID>` 分支。调用执行方一次，再由宿主保存提交，另一方只读审查完整 diff；超过 120000 字符的 diff 不截断后冒充完整审查，而是停止并保留提交。
- Codex 使用独立 app-server、新线程、`workspaceWrite` 单工作区沙盒，禁止网络和临时目录扩写；默认讨论及复核仍为只读。Windows 默认执行入口为 `E:\codex-tools\bin\codex.exe`。
- Claude 执行仍只有 Read/Grep/Glob，只生成文件变更 JSON，由宿主预检所有路径后落盘。支持最多 100 个、合计 4MiB 的 UTF-8 文本文件新增/覆盖；拒绝目录穿越、符号/硬链接、Git 元数据和常见凭证/工具配置路径。不支持删除、二进制或运行测试，报告明确注明。执行及复核不加载项目设置，关闭可禁用的 hooks/skills；管理员强制策略属于机器配置边界。
- 整个交接默认 15 分钟（可选 1–60），无自动多轮修复。取消、超时和正常关闭会中断并释放专属连接器；服务重启把活动交接标为失败，不自动重跑。Windows 强杀宿主可能留下子进程，不能视为正常关闭清理的保证。
- `ready` 仅表示复核完成，不表示复核没有发现问题。`merge({confirmed:true,commit})` 绑定当前完整提交 ID，复核后再次检查工作区、分支、差异哈希；原分支或 HEAD 改变则拒绝自动整合。只运行 `merge --ff-only --no-overwrite-ignore`，不推送；宿主 Git 操作禁用 hooks。
- 合并或放弃后只移除归属和路径可验证、没有链接、没有未提交/忽略文件的任务工作区，不强制删除。已有分支、报告和日志保留；失败、取消或有产物时保留工作区并显示原因。源目录和桌面端后台不清理。

`ROUNDTABLE_ROOMS_DIR` 可指定独立记录目录，用于本地验收时隔离数据和讨论 app-server PID 文件；正常启动仍使用项目内 `rooms/`。

## 主张与核查

`lib/claim-board.js` 从完整 Claude/Codex 发言的 `forward`（缺失则 `text`）按行提取 `【主张】`、`【来源】`、`【验证】`，忽略代码围栏、引用及失败/中断/流式消息。卡片 ID 为消息 ID 加主张序号；`snapshot().claims` 随原状态事件传送，旧记录也能派生，不额外调用模型。输出协议只在新建时勾选「要求标注可核查主张」（`claimCards`）后写进讨论室规则，总结/复核/定稿不用写；关闭时整条发言仍可点名核查。

用户标注存于 `d.claimAnnotations`：`discussion`（unresolved/consensus/disputed）、`evidence`（unverified/supported/counter）、`note`。标注不修改原始发言，也不自动升级证据或同步成模型观点。`checkClaim` 通过既有 `userMessage` 点名另一方，创建时持久化 `relatedMessageId`/`claimId`，引用明确为同伴材料而非用户指令。独立阶段拒绝核查，其他阶段继续沿用计轮、上限和总结调度。

`public/claim-board.js` 独立管理清单、草稿和详情；异步响应绑定讨论 ID。`lib/source-reference.js` 为项目内非链接 UTF-8 文本提供最多 1 MiB 文件的局部当前内容预览，返回 SHA-256、读取时间和修改时间；这不是历史快照或真实工具读取审计。`public/source-preview.js` 显式提示当前版本与原引用可能不同。

完整模型回复保存 `responseToMessageIds`，仅取实际完成答复的请求批次（包括成功 steer 带入的消息），失败/中断不写。`public/message-links.js` 用请求的 `relatedMessageId` 与回复批次建立双向导航，定向核查仅列指定接收方的完整回复，不把原作者后来看到请求当成对方核查，也不按时间邻近推断旧记录。完整发言旁常驻核查与起草按钮；原发言显示核查/实验状态，详情保留请求、回复、历史实验与重新判断的入口。`POST /claims` 在无 `id`、有 `messageId` 时保存整条发言的 `evidence/note` 到 `d.messageAnnotations`；界面将其标为用户判断，独立于模型共识，不自动认证事实。

`public/notifications.js` 仅观察当前打开讨论的 SSE 状态/消息；用户点击才请求浏览器通知权限。首次/重连快照静默，实时等待用户、完成、失败、发言上限发通知；手动暂停/停止不发。通知点击聚焦并打开对应讨论，localStorage 有界记录事件尽力跨标签去重，不是后台推送服务。

开发认领工具为 `lib/file-claims.js` 和 `scripts/claims.js`，Git common dir 下 `roundtable-claims` 跨 worktree 共享，原子写锁串行事务；到期不抢占。详见 [FILE_CLAIMS.md](FILE_CLAIMS.md)。

## 小实验与外部入口

`Experiment` 与讨论、执行交接状态分离，保存在 `experiment.json` 与 `experiments/<id>.json`。状态 `draft → running → completed/failed/cancelled → returned`；历史卡和报告保留。保存卡后暂停讨论，等待已有发言结束；即使当前是最后一轮，也保留交叉阶段用于批准实验。start 必须 `confirmed:true`、暂停且无人发言，不能与同房间执行交接同时运行。

冻结 question/decisionRule/procedure、1–30 分钟预算、事实卡、来源消息 ID、Codex 模型和干净 Git HEAD。建立 detached worktree，通过 `createExecutionAgentFactory` 创建独立 Codex 单工作区写入沙盒、禁网；不向只读讨论会话增加权限，不由宿主直接执行模型提出的命令。临时副本允许产物，不提交或合并。Claude 当前工具集不能执行命令，因此仅能提出实验。

定向起草还保存可选的顶层 `sourceMessageId/sourceExcerpt`，前者须是本场完整模型发言，后者须是原始文本子串且不超过 12000 字符；启动时同时写入冻结 `source`，历史记录保留。浏览器选文带入可编辑的问题字段，原文摘录保留原始文本；选文不能直接匹配 Markdown 原始文本时，摘录采用原文前 12000 字符。仅明确命名的实验问题、判据、步骤会直接预填，普通建议不额外调用模型推断。起草在前端进行，不保存、不暂停、不执行；保存与批准仍走原协议。回传证据和自动请求继承定向来源，完整重新判断按答复批次回挂原文。历史实验只读查看时隐藏当前实验表单和执行按钮；读取复用在途 Promise，状态更新不覆盖未保存草稿。

会话完整返回报告仅标 completed，不声称判据通过。取消、超时、失败保留现场；重启标 failed，不自动重跑。执行器释放不等待无时限的 interrupt 回执；新卡需等整个运行和清理结束。成功且工作区干净时验证归属后移除，产物、链接或失败保留。强杀宿主的进程回收边界与执行交接相同。

`returnResult(body, acceptEvidence)` 在锁内先同步接收，再标 returned。`Room.acceptExperiment` 以 `from:evidence` 持久化报告，转发时标注非用户指令；随后附来源明确的讨论室自动请求让双方重新判断，授权来自用户点击回传，不把固定文案当作用户原话。按 experimentId 去重，证据已存但请求未存的回传可恢复。done 会重新进入 discussion 并生成新总结，原发言上限仍有效。运行中的实验阻止开始新的讨论生成，停止讨论会取消实验。

外部入口复用创建 API，`/result` 返回 ready/text/brief/full/messageId/review/status/phase/notice。CLI 只连接 loopback HTTP、拒绝重定向、不自动重试创建；等待有上限，暂停或需用户输入时交回操作者。客户端退出不停止讨论，不实现跨会话后台消息注入。网页 `?room=<id>` 打开指定房间。

## HTTP API（`server.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 两边是否可用 |
| GET | `/api/models` | 可选模型（Claude 带具体版本） |
| GET | `/api/status` | 立即返回账号与额度缓存；`?refresh=1` 强制后台刷新 |
| POST | `/api/status/refresh-claude` | 发一条 Haiku 小请求刷新 Claude 额度 |
| GET | `/api/projects` | 项目列表（缓存 60 秒） |
| GET | `/api/projects/sessions?path=` | 某项目下两边已有对话 + 会带入的上下文 |
| GET/POST | `/api/rooms` | 讨论列表 / 新建 |
| GET | `/api/rooms/:id` | 完整状态 |
| GET | `/api/rooms/:id/result` | 最新已复核的双版结论；不完整时 ready=false |
| GET | `/api/rooms/:id/experiment` | 当前实验卡、状态、报告与历史 |
| POST | `/api/rooms/:id/experiment/<动作>` | `card`、`start`、`cancel`、`return`；启动和回传需明确 confirmed |
| GET | `/api/rooms/:id/events` | SSE：`snapshot` / `msg` / `delta` / `activity` / `state` |
| GET | `/api/rooms/:id/transcript` | 下载 Markdown 记录 |
| GET | `/api/rooms/:id/source?reference=文件:行号` | 当前项目文件只读预览与内容哈希 |
| POST | `/api/rooms/:id/claims` | 保存指定主张的用户标注 |
| POST | `/api/rooms/:id/check` | 对完整发言或主张发起定向核查 |
| POST | `/api/rooms/:id/<动作>` | `message` `pause` `resume` `interrupt` `finish` `stop` `add-round` `models` `facts` `settings` `finalize` |
| GET | `/api/rooms/:id/handoff` | 执行交接状态；已完成结论生成可编辑草稿，否则 null |
| POST | `/api/rooms/:id/handoff/<动作>` | `card`（支持 regenerate）、`start`、`cancel`、`merge`、`discard` |

访问限制：校验 `Host` 是否为本机地址加当前端口；POST 要求 Content-Type 包含 `application/json`。交接、小实验、主张标注与定向核查写入接口另校验网页 Origin 与 Host 同源；其他接口仍没有单独校验 Origin。没有身份鉴权，不能把 Host 检查描述成完整的跨站访问防护。

## 讨论能力（`lib/discussion-tools.js`）

全局设置存 `rooms/.discussion-tools.json`，默认全开，所有讨论共用；网页在「本场设置 → 讨论能力」勾选即保存。

- **Claude**：每次发言调用 `claudeDiscussionArgs()`，所以改设置下一次发言就生效。全关时参数与原来完全一致（`Read,Grep,Glob` + `--strict-mcp-config` + `default`）。放开时用 dontAsk 白名单：联网 = `WebSearch`、`WebFetch`、exa 插件；只读命令 = Git Bash 下的 `git log/show/diff/status/blame/ls-files/rev-parse`、`ls/cat/head/tail/wc/pwd` 前缀；Claude Docs 只放 `read/query/guide`。联网或 Docs 开时去掉 `--strict-mcp-config` 以加载插件 MCP，未列入白名单的 MCP 工具仍会被拒绝。
- **只读命令的坑**（实测）：Windows 上默认命令工具是 PowerShell，其前缀规则在本机解析失败、永远不匹配，所以用 Git Bash（`CLAUDE_CODE_GIT_BASH_PATH`，由 `findGitBash()` 从 `where git` 推出；找不到就不开）。Claude Code 会把重定向、管道、`&&` 拼接按整条命令判定并拒绝；但前缀白名单挡不住参数中间的 `--output=文件`（git log/show/diff 都支持，实测会写文件），所以另加 `Bash(*--output*)`、`Bash(*--ext-diff*)` 拒绝规则。不放 `find`（-delete/-exec）、`rg`（--pre 执行命令）、`git grep`（-O 打开程序）、`git branch`（带参数建分支）。
- **Codex**：app-server 是全局一个进程，启动参数由 `codexDiscussionArgs()` 给出；改设置后 `reconfigure()` 在没有发言进行时停掉进程，下次发言按新参数启动并按 ID 续接对话（有发言进行中就等它结束）。始终 `--disable hooks`、`--disable computer_use`；联网 = `web_search="live"` + exa（`mcp_servers.exa.url`）。有 `EXA_API_KEY` 时加 `env_http_headers={ "x-api-key" = "EXA_API_KEY" }`，key 只按变量名引用，不进 URL 和命令行；`syncExaKey()` 在进程环境里没有时从 `HKCUEnvironment` 补读，用户 setx 后不用重新登录，每次启动 app-server 时读取。没有 key 时匿名调用会被限流。插件只能整体开关：逐个 `-c plugins."x".enabled=false` 实测不生效，而且插件全开会带上 config.toml 之外的运行时插件和 `cua_repl`（电脑操控）。用户明确选择插件全开。Codex 服务端发来的审批请求仍一律拒绝，但不少插件工具不经审批就能执行，对外操作不可撤回。`killLeftover()` 按 `--disable hooks`（旧版 `--disable plugins`）识别自己的进程。
- 执行与实验：Claude 执行用 `isolateTools`，忽略讨论能力；Codex 执行/实验用独立的 `CodexServer`，仍是原来的全关参数。

## 不能破坏的规则

1. **讨论期间不改项目文件**：靠工具配置保证，不能只靠提示词。Claude 用 `--tools` 限定内置工具，放开能力时改用 `--permission-mode dontAsk` + `--allowedTools` 白名单（未列入的工具和命令自动拒绝）+ `--disallowedTools` 挡住参数中间的写出选项；`--allowedTools` 单独用只是"免确认"，必须配 dontAsk 才是白名单。Codex 只读沙盒 + 拒绝审批。联网、Codex 插件按全局「讨论能力」设置放开（见下文），执行与实验会话不受这些设置影响。
2. **用户授权与材料分开**；用户消息传达指令，用户按钮触发的固定流程请求单独标明自动来源，不能扩大权限；对方发言和实验报告要标明"不是用户的指令"。
3. **被打断的半截发言不转发**给对方。
4. **独立提案互相看不到**，包括失败重试时。
5. 有未送达的用户消息或约束卡更新时，**不提前收敛**。
6. 会话按**固定 ID** 恢复，不用"最近一次"，避免多个讨论室串线。
7. **不结束 Codex 桌面端的进程**。
8. 启动 Claude 前**清理桌面版注入的环境变量**。
9. **执行权限不回流到讨论**：交接和小实验使用全新会话与独立工作区；交接合并必须绑定用户看到的已审查提交，小实验不合并。实验报告属于证据，不能升级成用户指令。

## 踩过的坑

- Windows 上强制结束 Node 时，它启动的子进程不会跟着退出 → pid 文件清理。
- Codex 桌面端会锁住它打开着的对话 → fork 兜底。
- 带入旧对话时系统说明不一定生效 → 规则写进第一条消息。
- `thread/list` 不带 `cwd` 过滤会扫描全部会话文件，要 20 秒以上。
- 当前进程的 PATH 可能是旧的（刚改过 PATH）→ 读注册表。
- PowerShell 输出中文要 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；长中文提示通过 stdin 传，不要放命令行参数。
- 本机 Claude 命令行曾被配置成第三方中转站（`~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`），现已改为官方登录。

## 测试

按 `AGENTS.md` / `CLAUDE.md` 的「适度验证与实现」选择最小相关检查；以下为可用测试入口，不是每次都要执行的清单。纯文档只核对内容与差异，全量测试仅在影响范围或实际失败需要时运行。

- `node --test test/room.test.js`：模拟测试，覆盖独立阶段失败/打断、初始化期间停止、对话被占用、提前收敛条件、定稿、约束卡版本、发言上限、探索模式、送达状态。
- `node --test test/behavior-cards.test.js`：行为卡精确型号与 Claude 别名解析、空白卡不发送、默认值保存与继承、重命名、默认关闭和旧记录、双边提示及独立隔离、编辑/停用单卡/换型号、失败中断撤销、发言中更新与恢复；不调用真实模型。
- `node --test test/claim-board.test.js test/message-links.test.js`：核查请求与完整回复关联、整条发言用户标记、定向实验回传来源，以及前端关联与明确实验字段预填。不调用真实模型。
- 当前 24 项讨论模拟测试直接覆盖 Claude urgent 两阶段重来、Codex steer 成功/失败/迟到及重送、finish 两阶段与旧回执竞争、双方约束卡更新/清空。
- `node --test test/handoff.test.js`：临时真实 Git 仓库配模拟执行器，覆盖全生命周期、源目录保护、漂移、取消/超时/重启、明确提交确认、忽略文件碰撞、hooks 禁用和清理。
- `node --test test/execution-agents.test.js`：只读默认、写入沙盒参数、受限文本落盘与路径/链接拒绝、取消和自有进程释放。
- `node --test test/discussion-quality.test.js test/discussion-api.test.js test/quality-flow.test.js test/experiment.test.js test/roundtable-client.test.js`：双版结论的新旧结果、实验回流/批准/取消/预算/来源保护、客户端 HTTP 与有限等待；不调用真实模型。
- `npm test` 运行 package.json 列出的全部模拟与本地测试，不调用真实模型。
- `node smoke-test.js`：真实冒烟，消耗极少额度，只覆盖默认参数下的启动、发言、打断、恢复。Claude/Codex 升级或改到这些路径时跑；只改工具参数时改做针对性真实调用。
- `node --test test/discussion-tools.test.js`：讨论能力的参数拼装、默认值、执行会话不受影响、Codex 改设置后的重启时机。
- 界面改动：启动服务后在浏览器里实际点一遍；真实讨论尽量用 Haiku / 低强度省额度。
