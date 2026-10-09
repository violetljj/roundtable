'use strict';

// 应用窗口模式：常开一条连接告诉服务"窗口还开着"，窗口全部关掉服务就停。
// 有讨论正在进行时关窗口先确认一次（重启后会暂停在原处，点「继续」能接着讨论）。
(async () => {
  let app = false;
  try { app = (await fetch('/api/app-mode').then((r) => r.json())).app; } catch {}
  if (!app) return;
  new EventSource('/api/presence');
  let busy = false;
  const check = async () => {
    try { busy = (await fetch('/api/rooms').then((r) => r.json())).some((room) => room.status === 'running'); } catch {}
  };
  check();
  setInterval(check, 5000);
  window.addEventListener('beforeunload', (event) => {
    if (!busy) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
