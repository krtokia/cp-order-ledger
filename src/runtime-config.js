import { existsSync, readFileSync } from 'node:fs';
import {
  endOfDay,
  formatLocalDate,
  parseLocalDateInput,
  startOfDay,
  subtractDays
} from './date-utils.js';

const DEFAULT_CONFIG = {
  debug: false,
  maxPages: 10,
  notifications: {
    enabled: false,
    provider: 'ntfy',
    ntfy: {
      serverUrl: 'https://ntfy.sh',
      topic: '',
      token: ''
    },
    pushover: {
      apiUrl: 'https://api.pushover.net/1/messages.json',
      token: '',
      user: ''
    }
  },
  database: {
    enabled: false,
    type: 'sqlite',
    path: './data/orders.sqlite'
  },
  dateRange: {
    cutoffDate: null,
    daysAgo: 30,
    toDate: null
  }
};

export function loadRuntimeConfig({
  argv = process.argv.slice(2),
  configPath = './config/crawl-config.json',
  now = new Date()
} = {}) {
  const fileConfig = readJsonConfig(configPath);
  const cliConfig = parseCliArgs(argv);
  const dateRange = resolveDateRange(fileConfig.dateRange ?? {}, cliConfig, now);
  const debug = cliConfig.debug ?? fileConfig.debug ?? DEFAULT_CONFIG.debug;
  const maxPages = cliConfig.maxPages ?? fileConfig.maxPages ?? DEFAULT_CONFIG.maxPages;
  const notifications = resolveNotifications(fileConfig.notifications ?? {}, cliConfig, process.env);
  const database = resolveDatabase(fileConfig.database ?? {}, cliConfig);

  return {
    debug,
    maxPages,
    notifications,
    database,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    dateRangeSource: dateRange.source,
    debugDetailLogFile: `./debug.${formatLocalDate(now)}.log`
  };
}

export function parseCliArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--debug') {
      result.debug = true;
      continue;
    }

    if (arg === '--no-debug') {
      result.debug = false;
      continue;
    }

    if (arg === '--notify') {
      result.notify = true;
      continue;
    }

    if (arg === '--no-notify') {
      result.notify = false;
      continue;
    }

    if (arg === '--db') {
      result.databaseEnabled = true;
      continue;
    }

    if (arg === '--no-db') {
      result.databaseEnabled = false;
      continue;
    }

    const [rawKey, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const value = inlineValue ?? argv[index + 1];
    const consumedNext = inlineValue === null;

    switch (rawKey) {
      case '--cutoff-date':
      case '--from-date':
      case '--stop-date':
        result.cutoffDate = requireValue(rawKey, value);
        if (consumedNext) index += 1;
        break;

      case '--days-ago':
        result.daysAgo = parseNonNegativeInteger(requireValue(rawKey, value), rawKey);
        if (consumedNext) index += 1;
        break;

      case '--to-date':
      case '--end-date':
        result.toDate = requireValue(rawKey, value);
        if (consumedNext) index += 1;
        break;

      case '--max-pages':
        result.maxPages = parsePositiveInteger(requireValue(rawKey, value), rawKey);
        if (consumedNext) index += 1;
        break;

      case '--notify-provider':
        result.notifyProvider = requireValue(rawKey, value);
        if (consumedNext) index += 1;
        break;

      case '--db-path':
        result.databasePath = requireValue(rawKey, value);
        if (consumedNext) index += 1;
        break;

      default:
        break;
    }
  }

  return result;
}

function readJsonConfig(configPath) {
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    dateRange: {
      ...DEFAULT_CONFIG.dateRange,
      ...(parsed.dateRange ?? {})
    },
    notifications: {
      ...DEFAULT_CONFIG.notifications,
      ...(parsed.notifications ?? {}),
      ntfy: {
        ...DEFAULT_CONFIG.notifications.ntfy,
        ...(parsed.notifications?.ntfy ?? {})
      },
      pushover: {
        ...DEFAULT_CONFIG.notifications.pushover,
        ...(parsed.notifications?.pushover ?? {})
      }
    },
    database: {
      ...DEFAULT_CONFIG.database,
      ...(parsed.database ?? {})
    }
  };
}

function resolveDatabase(fileDatabase, cliConfig) {
  return {
    enabled: cliConfig.databaseEnabled ?? fileDatabase.enabled ?? DEFAULT_CONFIG.database.enabled,
    type: fileDatabase.type ?? DEFAULT_CONFIG.database.type,
    path: cliConfig.databasePath ?? fileDatabase.path ?? DEFAULT_CONFIG.database.path
  };
}

function resolveNotifications(fileNotifications, cliConfig, env) {
  const envEnabled = parseOptionalBoolean(env.CRAWL_NOTIFY_ENABLED);
  const provider = cliConfig.notifyProvider
    ?? env.CRAWL_NOTIFY_PROVIDER
    ?? fileNotifications.provider
    ?? DEFAULT_CONFIG.notifications.provider;

  return {
    enabled: cliConfig.notify ?? envEnabled ?? fileNotifications.enabled ?? DEFAULT_CONFIG.notifications.enabled,
    provider,
    ntfy: {
      serverUrl: env.NTFY_SERVER_URL ?? fileNotifications.ntfy?.serverUrl ?? DEFAULT_CONFIG.notifications.ntfy.serverUrl,
      topic: env.NTFY_TOPIC ?? fileNotifications.ntfy?.topic ?? DEFAULT_CONFIG.notifications.ntfy.topic,
      token: env.NTFY_TOKEN ?? fileNotifications.ntfy?.token ?? DEFAULT_CONFIG.notifications.ntfy.token
    },
    pushover: {
      apiUrl: env.PUSHOVER_API_URL ?? fileNotifications.pushover?.apiUrl ?? DEFAULT_CONFIG.notifications.pushover.apiUrl,
      token: env.PUSHOVER_TOKEN ?? fileNotifications.pushover?.token ?? DEFAULT_CONFIG.notifications.pushover.token,
      user: env.PUSHOVER_USER ?? fileNotifications.pushover?.user ?? DEFAULT_CONFIG.notifications.pushover.user
    }
  };
}

function resolveDateRange(fileDateRange, cliConfig, now) {
  const cutoff = resolveCutoffDate(fileDateRange, cliConfig, now);
  const endDate = resolveEndDate(fileDateRange, cliConfig, now);

  return {
    startDate: cutoff.date,
    endDate,
    source: cutoff.source
  };
}

function resolveCutoffDate(fileDateRange, cliConfig, now) {
  if (cliConfig.cutoffDate) {
    return {
      date: parseRequiredLocalDate(cliConfig.cutoffDate, '--cutoff-date'),
      source: 'cli:cutoffDate'
    };
  }

  if (cliConfig.daysAgo !== undefined) {
    return {
      date: startOfDay(subtractDays(now, cliConfig.daysAgo)),
      source: 'cli:daysAgo'
    };
  }

  if (fileDateRange.cutoffDate) {
    return {
      date: parseRequiredLocalDate(fileDateRange.cutoffDate, 'config.dateRange.cutoffDate'),
      source: 'config:cutoffDate'
    };
  }

  return {
    date: startOfDay(subtractDays(now, fileDateRange.daysAgo ?? DEFAULT_CONFIG.dateRange.daysAgo)),
    source: 'config:daysAgo'
  };
}

function resolveEndDate(fileDateRange, cliConfig, now) {
  if (cliConfig.toDate) return endOfDay(parseRequiredLocalDate(cliConfig.toDate, '--to-date'));
  if (fileDateRange.toDate) return endOfDay(parseRequiredLocalDate(fileDateRange.toDate, 'config.dateRange.toDate'));
  return new Date(now);
}

function parseRequiredLocalDate(value, label) {
  const date = parseLocalDateInput(value);
  if (!date) throw new Error(`${label}는 YYYY-MM-DD 형식이어야 합니다.`);
  return startOfDay(date);
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label}는 0 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label}는 1 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function parseOptionalBoolean(value) {
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

function requireValue(key, value) {
  if (value === null || value === undefined || String(value).startsWith('--')) {
    throw new Error(`${key} 값이 필요합니다.`);
  }
  return value;
}
