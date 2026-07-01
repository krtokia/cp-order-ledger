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
    return sendPushover(notificationConfig.pushover, { title, message });
  }

  return sendNtfy(notificationConfig.ntfy, { title, message });
}

async function sendNtfy(config, payload) {
  if (!config?.topic) {
    throw new Error('ntfy 알림을 보내려면 notifications.ntfy.topic 또는 NTFY_TOPIC이 필요합니다.');
  }

  const serverUrl = String(config.serverUrl || 'https://ntfy.sh').replace(/\/+$/, '');
  const headers = {
    Title: payload.title,
    Priority: 'high',
    Tags: 'warning'
  };

  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const response = await fetch(`${serverUrl}/${encodeURIComponent(config.topic)}`, {
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
    priority: '1'
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
