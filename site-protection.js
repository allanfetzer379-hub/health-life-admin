export function createSiteProtectionSettings(document, { loadSiteProtection, saveSiteProtection }) {
  const status = document.getElementById('protection-status');
  const toggle = document.getElementById('toggle-protection');
  const vpnToggle = document.getElementById('toggle-protection-vpn');
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
    vpnToggle.disabled = fields.disabled || typeof current?.vpnEnabled !== 'boolean';
    vpnToggle.setAttribute('aria-checked', String(current?.vpnEnabled === true));
    vpnToggle.textContent = current?.vpnEnabled ? '已开启' : '已关闭';
    save.disabled = fields.disabled || !whitelistChanged();
    retry.disabled = busy;
    status.textContent = loadFailed ? '读取失败' : current ? (current.enabled ? '已开启' : '已关闭') : '待读取';
    status.classList.toggle('enabled', !loadFailed && Boolean(current?.enabled));
    toggle.textContent = current?.enabled ? '关闭防护' : '开启防护';
  }

  function applyResult(result, keepWhitelistDraft = false) {
    if (typeof result?.enabled !== 'boolean' || !Array.isArray(result.whitelist) ||
        result.whitelist.some(ip => typeof ip !== 'string') ||
        (result.vpnEnabled !== undefined && typeof result.vpnEnabled !== 'boolean')) {
      throw new Error('服务器返回的防护设置格式不正确。');
    }
    current = result;
    if (!keepWhitelistDraft) whitelist.value = current.whitelist.join('\n');
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

  async function persist(action) {
    if (busy || loadFailed || !current) return;
    const changingVpn = action === 'vpn';
    const changingProtection = action === 'protection';
    const includesWhitelistChanges = whitelistChanged();
    const settings = changingVpn
      ? { vpnEnabled: !current.vpnEnabled }
      : { enabled: changingProtection ? !current.enabled : current.enabled, whitelist: readDraft() };
    busy = true;
    showFeedback({ vpn: '正在切换 VPN 拦截…', protection: '正在切换防护…', whitelist: '正在保存白名单…' }[action]);
    render();
    try {
      const result = await saveSiteProtection(settings);
      if (changingVpn && result?.vpnEnabled !== settings.vpnEnabled) {
        throw new Error('服务尚未确认 VPN 拦截设置，请刷新后核对。');
      }
      applyResult(result, changingVpn && includesWhitelistChanges);
      if (changingVpn) {
        const vpnStatus = current.vpnEnabled ? 'VPN 拦截已开启' : 'VPN 拦截已关闭';
        const pending = current.vpnEnabled && !current.enabled ? '，将在落地页防护开启后生效' : '';
        showFeedback(vpnStatus + pending + '。' + (includesWhitelistChanges ? '白名单有未保存的修改。' : ''));
      } else if (changingProtection) {
        const protectionStatus = current.enabled ? '防护已开启' : '防护已关闭';
        showFeedback(protectionStatus + (includesWhitelistChanges ? '，白名单已同步保存。' : '。'));
      } else {
        showFeedback('白名单已保存。');
      }
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
    if (whitelistChanged()) persist('whitelist');
  });
  toggle.addEventListener('click', () => {
    persist('protection');
  });
  vpnToggle.addEventListener('click', () => {
    if (typeof current?.vpnEnabled === 'boolean') persist('vpn');
  });
  render();
  return { open };
}
