export function createSiteProtectionSettings(document, { loadSiteProtection, saveSiteProtection }) {
  const status = document.getElementById('protection-status');
  const toggle = document.getElementById('toggle-protection');
  const form = document.getElementById('protection-form');
  const fields = document.getElementById('protection-fields');
  const whitelist = document.getElementById('protection-whitelist');
  const save = document.getElementById('save-protection-whitelist');
  const feedback = document.getElementById('protection-feedback');
  const retry = document.getElementById('retry-protection');
  let current;
  let busy = false;
  let loadFailed = false;

  function readDraft() {
    return [...new Set(whitelist.value.split(/\r?\n/).map(ip => ip.trim()).filter(Boolean))];
  }

  function whitelistChanged() {
    return Boolean(current && readDraft().join('\n') !== current.whitelist.join('\n'));
  }

  function showFeedback(message, error = false) {
    feedback.textContent = message;
    feedback.classList.toggle('error', error);
  }

  function render() {
    fields.disabled = busy || loadFailed || !current;
    toggle.disabled = fields.disabled;
    save.disabled = fields.disabled || !whitelistChanged();
    retry.disabled = busy;
    status.textContent = loadFailed ? '读取失败' : current ? (current.enabled ? '已开启' : '已关闭') : '待读取';
    status.classList.toggle('enabled', !loadFailed && Boolean(current?.enabled));
    toggle.textContent = current?.enabled ? '关闭防护' : '开启防护';
  }

  function applyResult(result) {
    if (typeof result?.enabled !== 'boolean' || !Array.isArray(result.whitelist) ||
        result.whitelist.some(ip => typeof ip !== 'string')) {
      throw new Error('服务器返回的防护设置格式不正确。');
    }
    current = result;
    whitelist.value = current.whitelist.join('\n');
  }

  async function open() {
    if (busy || whitelistChanged()) return;
    busy = true;
    retry.hidden = true;
    showFeedback('正在读取防护设置…');
    render();
    try {
      applyResult(await loadSiteProtection());
      loadFailed = false;
      showFeedback('');
    } catch (error) {
      loadFailed = true;
      retry.hidden = false;
      showFeedback(error.message || '读取防护设置失败，请重试。', true);
    } finally {
      busy = false;
      render();
    }
  }

  async function persist(enabled, switching) {
    if (busy || loadFailed || !current) return;
    const draft = readDraft();
    const includesWhitelistChanges = whitelistChanged();
    busy = true;
    showFeedback(switching ? '正在切换防护…' : '正在保存白名单…');
    render();
    try {
      applyResult(await saveSiteProtection({ enabled, whitelist: draft }));
      const changedStatus = current.enabled ? '防护已开启' : '防护已关闭';
      showFeedback(switching
        ? changedStatus + (includesWhitelistChanges ? '，白名单已同步保存。' : '。')
        : '白名单已保存。');
    } catch (error) {
      showFeedback(error.message || '保存失败，请重试。', true);
    } finally {
      busy = false;
      render();
    }
  }

  retry.addEventListener('click', open);
  whitelist.addEventListener('input', () => {
    showFeedback(whitelistChanged() ? '白名单有未保存的修改。' : '');
    render();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (whitelistChanged()) persist(current.enabled, false);
  });
  toggle.addEventListener('click', () => {
    if (current) persist(!current.enabled, true);
  });
  render();
  return { open };
}
