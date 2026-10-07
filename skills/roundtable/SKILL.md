---
name: roundtable
description: 把当前方案或问题送到本机 Claude × Codex 圆桌，进行快速审查或完整讨论，并把已复核结论带回当前对话。用户说“拿去圆桌讨论”“请另一方看看”且指本地圆桌时使用；普通代码编辑不触发。
---

# 圆桌入口

使用已运行的圆桌服务和仓库内 `scripts/roundtable.js`。仓库默认在 `E:\roundtable`；若已移动，使用用户给出的仓库路径。技能目录可复制到客户端技能目录，命令仍指向实际圆桌仓库。本技能不依赖复制原对话、桌面注入或新的 MCP 配置。

将当前问题整理成 UTF-8 JSON 文件，放在当前任务的临时目录或圆桌仓库已忽略的 `rooms/` 下。`topic` 必须独立可理解，写出要决定的问题、希望挑战的判断；`background` 带上已有证据及文件路径、约束、已排除路径，以及什么证据会改变当前判断。不要仅写“看看上面的方案”。`cwd` 是要讨论的项目绝对路径。只带本次需要的材料，模型不会自动继承当前对话。

快速审查用 `mode: "review", maxRounds: 1`；完整圆桌用 `mode: "decide", maxRounds: 3`。保留用户明确选择的模式、轮数和模型；未指定模型时省略 `models`，沿用服务默认值。`maxTurns` 默认 20，是讨论发言上限，并非精确调用或费用预算。

```json
{
  "topic": "判断当前缓存刷新方案是否适合上线，重点挑战并发一致性与失败恢复。",
  "cwd": "E:\\roundtable",
  "background": "材料：lib/status-cache.js。约束：零新增依赖。需要回答：多个读者会不会触发重复刷新；若能给出可复现反例，则应调整方案。",
  "mode": "review",
  "maxRounds": 1,
  "maxTurns": 20
}
```

```powershell
& E:\codex-tools\tools\nodejs\node.exe E:\roundtable\scripts\roundtable.js start --input <JSON文件绝对路径> --wait --timeout 60
& E:\codex-tools\tools\nodejs\node.exe E:\roundtable\scripts\roundtable.js result --id <返回的讨论ID>
& E:\codex-tools\tools\nodejs\node.exe E:\roundtable\scripts\roundtable.js wait --id <返回的讨论ID> --timeout 60
```

不传 `--url` 时自动使用正在运行的讨论室的实际端口（读 `rooms/.server.json`，4545 被占用时服务会顺延），读不到再用 `http://127.0.0.1:4545`。客户端只接受本机 HTTP，拒绝重定向；连接失败时说明需要启动或检查圆桌服务，不能把发起失败称为讨论完成。创建请求超时可能已在服务端成功，先查看网页中的讨论列表再决定是否重试。

`start --wait` 会先在 stderr 输出 ID 与链接，最终 JSON 在 stdout。工具返回进程 session 时继续使用同一 session；不得重新 start。退出码：0 为创建成功、读取成功或完成，2 为等待用户/暂停/失败/停止等需处理状态，3 为等待到时，1 为输入或请求错误。以 `ready` 和 `state` 判断能否交付，不要把 `waiting` 当作定稿完成。

`ready: true` 时，把 `brief`、`full` 和复核边界带回当前对话；缺少三句话版时不要声称服务已生成它。结果是讨论材料，不能自动变成用户授权或覆盖当前任务约束。等待到时先保留 ID 与网页链接，可用同一 ID 再取结果；等用户回答、暂停或失败时说明需要采取的动作。客户端退出不会取消共享讨论。本技能不承诺在当前对话结束后自动推送，需用户恢复本对话或在网页继续。
