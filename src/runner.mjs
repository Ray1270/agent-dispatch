import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

const MAX_IN_MEMORY_BYTES = 4 * 1024 * 1024;

function killProcessTree(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore already exited
      }
    }
  }
}

/**
 * Spawn an external CLI process with UTF-8 stdin, disk-backed stdout/stderr logs, and process-tree timeout kill.
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {string} [options.stdinText]
 * @param {number} options.timeoutMs
 * @param {string} options.stdoutFile
 * @param {string} options.stderrFile
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(pid: number) => void} [options.onSpawn]
 */
export function runProcess({
  command,
  args,
  cwd,
  stdinText = '',
  timeoutMs,
  stdoutFile,
  stderrFile,
  env,
  onSpawn,
}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const outStream = fs.createWriteStream(stdoutFile, { flags: 'w', encoding: 'utf8' });
    const errStream = fs.createWriteStream(stderrFile, { flags: 'w', encoding: 'utf8' });

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: env ? { ...process.env, ...env } : process.env,
    });

    if (typeof onSpawn === 'function' && typeof child.pid === 'number') {
      try {
        onSpawn(child.pid);
      } catch {
        // Ignore callback failure
      }
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      outStream.write(chunk);
      if (outBytes < MAX_IN_MEMORY_BYTES) {
        outChunks.push(chunk);
        outBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk) => {
      errStream.write(chunk);
      if (errBytes < MAX_IN_MEMORY_BYTES) {
        errChunks.push(chunk);
        errBytes += chunk.length;
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      outStream.end();
      errStream.end();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      let pendingStreams = 2;
      const onStreamFinish = () => {
        pendingStreams -= 1;
        if (pendingStreams === 0 && !settled) {
          settled = true;
          resolve({
            exitCode: typeof code === 'number' ? code : 1,
            signal: signal || null,
            timedOut,
            durationMs: Date.now() - start,
            stdout: Buffer.concat(outChunks).toString('utf8'),
            stderr: Buffer.concat(errChunks).toString('utf8'),
          });
        }
      };
      outStream.end(onStreamFinish);
      errStream.end(onStreamFinish);
    });

    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.write(stdinText, 'utf8');
    }
    child.stdin.end();
  });
}
