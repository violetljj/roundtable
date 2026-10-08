// 讨论能力：全局设置，所有讨论共用，勾选即保存。
const ITEMS = [
  { key: 'web', label: '联网查资料', note: '双方可网页搜索；Claude 还能读网页、用 exa，Codex 也接上 exa（未登录，可能限流）。' },
  { key: 'claudeShell', label: 'Claude 跑只读命令', note: '只放行 git log/show/diff/status/blame 和 ls、cat、head、tail、wc 等；写文件、重定向、管道和 --output 一律拒绝。' },
  { key: 'claudeDocs', label: 'Claude 读 Claude Docs', note: '只能读取和检索文档，创建、编辑、删除都会被拒绝。' },
  { key: 'codexPlugins', label: 'Codex 插件全开', note: '包括浏览器、文档、Slack、日历和电脑操控插件。Codex 不弹窗确认，插件的对外操作发出去撤不回。项目文件仍是只读。' },
];

export function initDiscussionTools({ api }) {
  const section = document.getElementById('discussionToolsSection');
  const list = section.querySelector('.dtools');
  const error = section.querySelector('.form-error');
  let state = null;

  function render() {
    list.replaceChildren(...ITEMS.map((item) => {
      const label = document.createElement('label');
      label.className = 'opt-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!state?.settings[item.key];
      input.disabled = !state;
      input.onchange = () => save({ [item.key]: input.checked });
      const text = document.createElement('span');
      const note = item.key === 'claudeShell' && state && !state.gitBash ? '没找到 Git Bash，这一项暂时用不了。' : item.note;
      text.innerHTML = `${item.label}<span class="fine"></span>`;
      text.querySelector('.fine').textContent = note;
      label.append(input, text);
      return label;
    }));
  }

  async function save(change) {
    error.textContent = '';
    try { state = await api('/api/discussion-tools', { ...state.settings, ...change }); }
    catch (e) { error.textContent = e.message; }
    render();
  }

  async function load() {
    try { state = await api('/api/discussion-tools'); error.textContent = ''; }
    catch (e) { error.textContent = e.message; }
    render();
  }

  render();
  document.getElementById('roomToolsDialog').addEventListener('toggle', (e) => { if (e.newState === 'open') load(); });
  load();
}
