const HEARTBEAT_MS = 20_000;
const JOIN_TIMEOUT_MS = 15_000;
const CHANGE_DELAY_MS = 160;
const MAX_BATCH = 30;
const MAX_PENDING = 200;
const RETRY_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];
const CHANGE_TYPES = new Set(['insert', 'update', 'remove']);

export function startOrderRealtime({
  url, apiKey, role, userId, getAccessToken, syncOrders, applyChanges, setStatus,
}) {
  if (!globalThis.WebSocket || !['admin', 'staff'].includes(role) || (role === 'staff' && !userId)) {
    setStatus('offline');
    return () => {};
  }

  // Supabase Realtime's documented Phoenix v1 protocol uses JSON text frames.
  const endpoint = new URL('/realtime/v1/websocket', url);
  if (endpoint.protocol !== 'https:') throw new Error('实时连接需要 HTTPS。');
  endpoint.protocol = 'wss:';
  endpoint.searchParams.set('apikey', apiKey);
  endpoint.searchParams.set('vsn', '1.0.0');
  const topic = role === 'admin' ? 'realtime:nk-orders:admin' : `realtime:nk-orders:staff:${userId}`;

  const pending = new Map();
  let active, retryTimer, updateTimer, state;
  let retryStep = 0;
  let stopped = false;
  let working = false;
  let hasConnected = false;

  function show(next) {
    if (state === next) return;
    state = next;
    setStatus(next);
  }

  function clearConnection() {
    if (!active) return;
    const connection = active;
    active = undefined;
    clearTimeout(connection.joinTimer);
    clearInterval(connection.heartbeatTimer);
    clearTimeout(updateTimer);
    updateTimer = undefined;
    pending.clear();
    if (connection.socket?.readyState < WebSocket.CLOSING) connection.socket.close();
  }

  function retry(connection) {
    if (stopped || active !== connection) return;
    clearConnection();
    show('offline');
    if (globalThis.navigator?.onLine === false) return;
    const delay = RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay);
  }

  function scheduleUpdate(delay = CHANGE_DELAY_MS) {
    if (!active?.ready || working || updateTimer !== undefined) return;
    updateTimer = setTimeout(() => { updateTimer = undefined; flush(active); }, delay);
  }

  async function flush(connection) {
    if (!connection?.ready || active !== connection || working) return;
    working = true;
    try {
      if (connection.snapshotReason) {
        const reason = connection.snapshotReason;
        connection.snapshotReason = undefined;
        await syncOrders(reason);
        if (active === connection) {
          hasConnected = true;
          retryStep = 0;
          show('live');
        }
      } else if (pending.size) {
        const batch = Array.from(pending).slice(0, MAX_BATCH);
        const ids = batch.map(([id]) => id);
        const newIds = batch.filter(([, type]) => type === 'insert').map(([id]) => id);
        for (const id of ids) pending.delete(id);
        await applyChanges({ ids, newIds });
      }
    } catch {
      retry(connection);
    } finally {
      working = false;
      if (active?.snapshotReason || pending.size) scheduleUpdate();
    }
  }

  function enqueue(connection, change) {
    if (!change || typeof change.id !== 'string' || !change.id || change.id.length > 150 ||
        !CHANGE_TYPES.has(change.type)) return;
    const previous = pending.get(change.id);
    pending.set(change.id, previous === 'insert' && change.type === 'update' ? 'insert' : change.type);
    if (pending.size > MAX_PENDING) {
      pending.clear();
      connection.snapshotReason = 'recovery';
    }
    scheduleUpdate();
  }

  function push(connection, event, payload, target = topic) {
    const ref = String(++connection.nextRef);
    const joinRef = event === 'phx_join' ? ref : connection.joinRef;
    connection.socket.send(JSON.stringify({
      topic: target, event, payload, ref, join_ref: target === topic ? joinRef : null,
    }));
    return ref;
  }

  async function refreshToken(connection) {
    if (connection.refreshingToken) return;
    connection.refreshingToken = true;
    try {
      const token = await getAccessToken();
      if (active !== connection) return;
      if (!token) throw new Error('Realtime session expired');
      if (token !== connection.token) {
        push(connection, 'access_token', { access_token: token });
        connection.token = token;
      }
    } catch {
      retry(connection);
    } finally {
      connection.refreshingToken = false;
    }
  }

  function heartbeat(connection) {
    if (active !== connection) return;
    if (connection.heartbeatRef || connection.socket.readyState !== WebSocket.OPEN) {
      retry(connection);
      return;
    }
    try {
      connection.heartbeatRef = push(connection, 'heartbeat', {}, 'phoenix');
      if (connection.ready) refreshToken(connection);
    } catch {
      retry(connection);
    }
  }

  function receive(connection, data) {
    if (active !== connection || typeof data !== 'string') return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const { topic: target, event, payload, ref } = message;
    if (target === 'phoenix' && event === 'phx_reply' && ref === connection.heartbeatRef) {
      if (payload?.status !== 'ok') { retry(connection); return; }
      connection.heartbeatRef = undefined;
      return;
    }
    if (target !== topic) return;
    if (event === 'phx_close' || event === 'phx_error' ||
        (event === 'system' && ['error', 'timeout'].includes(payload?.status))) {
      retry(connection);
      return;
    }
    if (event === 'broadcast' && payload?.event === 'order_changed') {
      enqueue(connection, payload.payload);
      return;
    }
    if (event === 'phx_reply' && ref === connection.joinRef) {
      if (payload?.status !== 'ok') { retry(connection); return; }
      connection.joined = true;
    }
    if (event === 'system' && payload?.status === 'ok' && payload.extension === 'system') {
      connection.replicationReady = true;
    }
    if (connection.ready || !connection.joined || !connection.replicationReady) return;

    clearTimeout(connection.joinTimer);
    connection.ready = true;
    // Snapshot after subscribing so the browser catches up across connection gaps.
    connection.snapshotReason = hasConnected ? 'reconnect' : 'initial';
    scheduleUpdate(0);
  }

  async function connect() {
    if (stopped || active) return;
    if (globalThis.navigator?.onLine === false) { show('offline'); return; }
    show('connecting');
    const connection = { nextRef: 0 };
    active = connection;
    connection.joinTimer = setTimeout(() => retry(connection), JOIN_TIMEOUT_MS);
    try {
      connection.token = await getAccessToken();
      if (active !== connection) return;
      if (!connection.token) throw new Error('Realtime session expired');
      const socket = new WebSocket(endpoint);
      connection.socket = socket;
      socket.addEventListener('open', () => {
        if (active !== connection) return;
        try {
          connection.joinRef = push(connection, 'phx_join', {
            config: {
              private: true,
              broadcast: { ack: false, self: false, replication_ready: true },
              presence: { enabled: false },
              postgres_changes: [],
            },
            access_token: connection.token,
          });
          connection.heartbeatTimer = setInterval(() => heartbeat(connection), HEARTBEAT_MS);
        } catch {
          retry(connection);
        }
      });
      socket.addEventListener('message', ({ data }) => receive(connection, data));
      socket.addEventListener('close', () => retry(connection));
      socket.addEventListener('error', () => retry(connection));
    } catch {
      retry(connection);
    }
  }

  function resume() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    connect();
  }

  function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearConnection();
    show('offline');
  }

  globalThis.addEventListener?.('online', resume);
  globalThis.addEventListener?.('offline', disconnect);
  globalThis.addEventListener?.('pageshow', resume);
  globalThis.addEventListener?.('pagehide', disconnect);
  connect();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    clearConnection();
    globalThis.removeEventListener?.('online', resume);
    globalThis.removeEventListener?.('offline', disconnect);
    globalThis.removeEventListener?.('pageshow', resume);
    globalThis.removeEventListener?.('pagehide', disconnect);
  };
}
