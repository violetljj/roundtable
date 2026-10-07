# 文件认领

这是 Claude 与 Codex 开始修改前互相避让的登记工具。它是提示式协作，不能阻止绕过工具直接编辑，也不能替代检查 `git status` 和保护他人的未提交改动。独立 worktree 也可能最终修改同一个文件，因此共享一份登记。

## 使用

在仓库根目录运行（本机 Node 为 `E:\codex-tools\tools\nodejs\node.exe`）：

```powershell
node scripts/claims.js list
node scripts/claims.js claim --owner Codex --task "改进讨论面板" --minutes 60 public/app.js public/style.css
```

成功后保存 JSON 中的 `token`；它标识本次认领，防止同名持有者误释放另一项任务。后续操作必须同时匹配持有者和凭据：

```powershell
node scripts/claims.js renew --owner Codex --token <认领凭据> --minutes 60 public/app.js public/style.css
node scripts/claims.js release --owner Codex --token <认领凭据> public/app.js public/style.css
```

命令支持 `--repo <仓库路径>`。文件路径始终相对于该仓库的根目录，支持中文和 Windows 反斜线；Windows 上忽略大小写。以 `--` 分隔可传入以 `--` 开头的文件名。只认领具体文件，包括尚未创建的文件；拒绝绝对路径、父目录穿越、Git 元数据、符号链接或目录链接。

每条记录含文件、持有者、任务、更新时间和预计到期时间，`list` 额外显示 `stale`。**到期只是可能失联的提示，原认领仍有效。** 先联系持有者确认结束，再由原持有者释放；本工具没有强制抢占命令。`list` 不展示凭据，`claim` 的成功输出包含凭据。

## 一致性与恢复

登记保存在 Git common dir 下的 `roundtable-claims/claims.json`，不进入工作区或提交。所有关联 worktree 使用同一份登记。批量认领、续期和释放先检查所有文件，再一次写入；任意文件冲突，整批保持原状。并发写入通过原子创建 `write.lock` 目录互斥，最长等待 5 秒；登记通过临时文件加原子重命名更新。

正常结束会释放写锁。进程被强杀可能留下 `write.lock` 或 `.tmp` 文件：确认已没有认领命令运行后，可人工移除**该空锁目录及对应遗留临时文件**，保留 `claims.json`。不会按时间自动抢锁。凭据丢失或持有者永久离线时，需要人工核对登记后恢复；不要把预计到期当成可安全删除的依据。

认领是文件级约定，不包含目录树锁，也不检测硬链接或文件重命名后的身份。它适合合作中的开发代理，不是权限控制或抵御恶意本机进程的机制。

验证命令：`node --test test/file-claims.test.js`。不调用模型、不引入依赖。
