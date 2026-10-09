'use strict';

// 后台模式：常开一条连接告诉服务"页面还开着"。页面全部关掉、且没有讨论在进行时，服务自己停。
(async () => {
  let app = false;
  try { app = (await fetch('/api/app-mode').then((r) => r.json())).app; } catch {}
  if (app) new EventSource('/api/presence');
})();
