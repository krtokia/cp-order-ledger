import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

const DEFAULT_ROTATE_OPTIONS = {
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 5
};

export function installConsoleFileLogger(logFile, rotateOptions = DEFAULT_ROTATE_OPTIONS) {
  mkdirSync(dirname(logFile), { recursive: true });
  rotateLogIfNeeded(logFile, rotateOptions);

  const logStream = createWriteStream(logFile, { flags: 'a' });
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  function write(method, args) {
    const message = format(...args);
    logStream.write(`${message}\n`);
    originalConsole[method](...args);
  }

  console.log = (...args) => write('log', args);
  console.warn = (...args) => write('warn', args);
  console.error = (...args) => write('error', args);

  return () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    logStream.end();
  };
}

function rotateLogIfNeeded(logFile, options) {
  const maxBytes = Number(options.maxBytes) || DEFAULT_ROTATE_OPTIONS.maxBytes;
  const maxFiles = Number(options.maxFiles) || DEFAULT_ROTATE_OPTIONS.maxFiles;

  if (!existsSync(logFile) || statSync(logFile).size < maxBytes) return;

  const lastLogFile = `${logFile}.${maxFiles}`;
  if (existsSync(lastLogFile)) unlinkSync(lastLogFile);

  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const currentFile = `${logFile}.${index}`;
    const nextFile = `${logFile}.${index + 1}`;
    if (existsSync(currentFile)) renameSync(currentFile, nextFile);
  }

  renameSync(logFile, `${logFile}.1`);
}
