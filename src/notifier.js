export async function sendFailureNotification(notificationConfig, failure) {
  if (!notificationConfig?.enabled) {
    return { sent: false, reason: 'disabled' };
  }

  const title = failure.title ?? '쿠팡 크롤러 중단';
  const message = [
    failure.message,
    failure.context ? `\n${failure.context}` : ''
  ].join('').trim();

  if (notificationConfig.provider === 'pushover') {
    return sendPushover({
      priority: notificationConfig.priority,
      ...notificationConfig.pushover
    }, { title, message });
  }

  return sendNtfy({
    priority: notificationConfig.priority,
    ...notificationConfig.ntfy
  }, { title, message });
}

async function sendNtfy(config, payload) {
  if (!config?.topic) {
    throw new Error('ntfy 알림을 보내려면 notifications.ntfy.topic 또는 NTFY_TOPIC이 필요합니다.');
  }

  const serverUrl = String(config.serverUrl || 'https://ntfy.sh').replace(/\/+$/, '');
  const url = new URL(`${serverUrl}/${encodeURIComponent(config.topic)}`);
  url.searchParams.set('title', payload.title);
  url.searchParams.set('priority', resolveNtfyPriority(config.priority));
  url.searchParams.set('tags', 'warning');

  const headers = {};

  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: payload.message
  });

  await assertOkResponse(response, 'ntfy');
  return { sent: true, provider: 'ntfy' };
}

async function sendPushover(config, payload) {
  if (!config?.token || !config?.user) {
    throw new Error('Pushover 알림을 보내려면 notifications.pushover.token/user 또는 PUSHOVER_TOKEN/PUSHOVER_USER가 필요합니다.');
  }

  const body = new URLSearchParams({
    token: config.token,
    user: config.user,
    title: payload.title,
    message: payload.message,
    priority: resolvePushoverPriority(config.priority)
  });

  const response = await fetch(config.apiUrl || 'https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body
  });

  await assertOkResponse(response, 'Pushover');
  return { sent: true, provider: 'pushover' };
}

async function assertOkResponse(response, provider) {
  if (response.ok) return;

  const text = await response.text().catch(() => '');
  throw new Error(`${provider} 알림 전송 실패: HTTP ${response.status}${text ? ` ${text}` : ''}`);
}

function resolveNtfyPriority(priority = 'high') {
  const value = String(priority ?? 'high').trim().toLowerCase();
  const priorities = {
    '1': 'min',
    '2': 'low',
    '3': 'default',
    '4': 'high',
    '5': 'urgent',
    silent: 'min',
    min: 'min',
    lowest: 'min',
    low: 'low',
    normal: 'default',
    default: 'default',
    high: 'high',
    urgent: 'urgent',
    emergency: 'urgent'
  };

  if (priorities[value]) return priorities[value];

  throw new Error('notifications.priority는 silent, low, normal, high, urgent 중 하나여야 합니다.');
}

function resolvePushoverPriority(priority = 'high') {
  const value = String(priority ?? 'high').trim().toLowerCase();
  const priorities = {
    '-2': '-2',
    '-1': '-1',
    '0': '0',
    '1': '1',
    silent: '-2',
    min: '-2',
    lowest: '-2',
    low: '-1',
    normal: '0',
    default: '0',
    high: '1',
    urgent: '1'
  };

  if (priorities[value]) return priorities[value];

  if (value === '2' || value === 'emergency') {
    throw new Error('Pushover emergency priority(2)는 retry/expire 설정이 필요합니다. 현재는 silent, low, normal, high, urgent를 사용하세요.');
  }

  throw new Error('notifications.priority는 silent, low, normal, high, urgent 중 하나여야 합니다.');
}
