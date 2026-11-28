import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PtyHandle, Sandbox } from '@cubesandbox/sdk';

export interface RuntimeBundle {
  archivePath: string;
  archiveSha256: string;
  size: number;
}

export interface RuntimeBundleProgressEvent {
  stage: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  details?: Record<string, string | number | boolean | null>;
  durationMs?: number;
}

export async function startGuestPty(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  envs: Record<string, string> = {},
  disableEcho = false,
): Promise<PtyHandle> {
  const handle = await sandbox.pty.create({ rows: 24, cols: 80 }, { cwd, envs, timeoutMs: 0 });
  try {
    if (disableEcho) await handle.sendStdin('stty -echo 2>/dev/null || true\n', 15_000);
    await handle.sendStdin(command + '\n', 15_000);
    return handle;
  } catch (error) {
    handle.disconnect();
    throw error;
  }
}

export async function runGuestPty(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  envs: Record<string, string> = {},
  onOutputLine?: (line: string) => void,
  maxDurationMs = 0,
): Promise<{ exitCode: number; output: string }> {
  // Replace Cube's interactive login shell with a non-interactive bash process.
  // Sending `exit $?` in the same PTY write is unreliable for long commands:
  // the command can finish and print its final marker while the login shell
  // remains attached, leaving wait() blocked indefinitely.
  const handle = await startGuestPty(sandbox, `exec bash -c ${shellQuote(command)}`, cwd, envs, true);
  const decoder = new TextDecoder();
  let output = '';
  let pendingLine = '';
  const collect = (text: string): void => {
    output += text;
    if (!onOutputLine) return;
    pendingLine += text;
    let newline: number;
    while ((newline = pendingLine.indexOf('\n')) >= 0) {
      const line = pendingLine.slice(0, newline).replace(/\r$/, '');
      pendingLine = pendingLine.slice(newline + 1);
      if (line.trim()) onOutputLine(line.slice(0, 2400));
    }
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const wait = handle.wait(chunk => collect(decoder.decode(chunk, { stream: true })));
    const exitCode = maxDurationMs > 0
      ? await Promise.race([
        wait,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Guest PTY exceeded its ${maxDurationMs}ms build step limit.`)), maxDurationMs);
        }),
      ])
      : await wait;
    collect(decoder.decode());
    if (pendingLine.trim()) onOutputLine?.(pendingLine.slice(0, 2400));
    return { exitCode, output };
  } catch (error) {
    if (timeout) await handle.kill().catch(() => false);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    handle.disconnect();
  }
}

// Cube's envd file endpoint is behind the Cube API/OpenResty data path. Keep
// individual requests small enough to avoid long proxy-held uploads, and cap
// concurrent bytes in flight; template-build logs on 2026-11-21 showed 502s on
// concurrent 8 MiB writes near the end of a 144 MB runtime transfer.
const uploadChunkBytes = 4 * 1024 * 1024;
const uploadConcurrency = 2;
const uploadMaxAttempts = 5;
// A 2026-11-28 ARM64 microVM run needed about eight minutes to upload the
// 144 MB DSH archive, then took roughly eight minutes to concatenate only
// 24/35 chunks in the guest. Keep this bounded while allowing the observed
// slow guest filesystem path enough time to finish a cold install.
const assemblyTimeoutMs = 20 * 60_000;

export async function stageRuntimeBundle(
  sandbox: Sandbox,
  bundle: RuntimeBundle,
  reportProgress: (event: RuntimeBundleProgressEvent) => Promise<void>,
  runtimeLabel = 'DeepSeek Harness',
  destinationPath = '/tmp/csa-dsh-runtime-linux-arm64.tar.gz',
): Promise<void> {
  const archivePath = destinationPath;
  const checksumPath = `${archivePath}.sha256`;
  const uploadId = randomUUID();
  const assemblyScriptPath = `/tmp/csa-dsh-runtime-${uploadId}.assemble.sh`;
  const assemblyExitPath = `/tmp/csa-dsh-runtime-${uploadId}.assemble.exit`;
  const assemblyLogPath = `/tmp/csa-dsh-runtime-${uploadId}.assemble.log`;
  await reportProgress({
    stage: 'transfer.local-read.start',
    level: 'info',
    message: `读取 Mac 上缓存的 ${runtimeLabel} Linux ARM64 包。`,
    details: { uploadId, expectedBytes: bundle.size, expectedSha256: bundle.archiveSha256 },
  });
  const localReadStartedAt = Date.now();
  let bytes: Buffer;
  try {
    bytes = await readFile(bundle.archivePath);
  } catch (error) {
    await reportProgress({
      stage: 'transfer.local-read.failed',
      level: 'error',
      message: `无法读取 Mac 上缓存的 ${runtimeLabel} Linux ARM64 包。`,
      details: { uploadId, error: safeUploadError(error) },
      durationMs: Date.now() - localReadStartedAt,
    });
    throw error;
  }
  await reportProgress({
    stage: 'transfer.local-read.complete',
    level: 'info',
    message: `Mac 上的 ${runtimeLabel} 包已读取。`,
    details: { uploadId, actualBytes: bytes.byteLength, expectedBytes: bundle.size },
    durationMs: Date.now() - localReadStartedAt,
  });
  if (bytes.byteLength !== bundle.size) {
    const error = new Error('Mac 上的 ' + runtimeLabel + ' runtime 依赖包大小发生变化。');
    await reportProgress({ stage: 'transfer.local-read.validation-failed', level: 'error', message: error.message, details: { uploadId, actualBytes: bytes.byteLength, expectedBytes: bundle.size } });
    throw error;
  }
  const chunkCount = Math.ceil(bytes.byteLength / uploadChunkBytes);
  const assemblyPartPaths: string[] = Array.from({ length: chunkCount }, () => '');
  const temporaryPartPaths: string[] = [];
  const sandboxInspectStartedAt = Date.now();
  await reportProgress({ stage: 'transfer.sandbox-inspect.start', level: 'info', message: '检查 CubeSandbox 构建 microVM 状态后再开始上传。', details: { uploadId, sandboxId: sandbox.sandboxId } });
  let initialSandboxInfo: Awaited<ReturnType<typeof sandbox.getInfo>>;
  try {
    initialSandboxInfo = await sandbox.getInfo();
  } catch (error) {
    await reportProgress({ stage: 'transfer.sandbox-inspect.failed', level: 'error', message: '读取 CubeSandbox 构建 microVM 状态失败。', details: { uploadId, sandboxId: sandbox.sandboxId, error: safeUploadError(error) }, durationMs: Date.now() - sandboxInspectStartedAt });
    throw error;
  }
  const initialRestartMarker = restartMarker(initialSandboxInfo);
  await reportProgress({ stage: 'transfer.sandbox-inspect.complete', level: 'info', message: 'CubeSandbox 构建 microVM 状态已确认。', details: { uploadId, sandboxId: sandbox.sandboxId, state: String(initialSandboxInfo.state || 'unknown'), restartMarker: initialRestartMarker }, durationMs: Date.now() - sandboxInspectStartedAt });
  let lastRestartCheckAt = Date.now();
  let restartCheckPromise: Promise<void> | undefined;
  const assertSandboxDidNotRestart = async (): Promise<void> => {
    if (restartCheckPromise) return restartCheckPromise;
    if (Date.now() - lastRestartCheckAt < 20_000) return;
    restartCheckPromise = sandbox.getInfo().then(info => {
      if (restartMarker(info) !== initialRestartMarker) {
        throw new Error('CubeSandbox 在 Agent Runtime 传输期间重启了构建 VM。');
      }
    });
    try {
      await restartCheckPromise;
    } finally {
      lastRestartCheckAt = Date.now();
      restartCheckPromise = undefined;
    }
  };

  await reportProgress({
    stage: 'transfer.start',
    level: 'info',
    message: '开始向 microVM 传输 ' + runtimeLabel + ' runtime。',
    details: { uploadId, bytes: bundle.size, sha256: bundle.archiveSha256, chunkBytes: uploadChunkBytes, chunkCount, concurrency: uploadConcurrency, destination: archivePath },
  });
  try {
    await reportProgress({ stage: 'transfer.remote-cleanup.start', level: 'info', message: `清理 microVM 中上次未完成的 ${runtimeLabel} 包。`, details: { uploadId, paths: 2 } });
    await sandbox.files.remove(archivePath).catch(error => reportProgress({ stage: 'transfer.remote-cleanup.warning', level: 'warning', message: `删除旧 ${runtimeLabel} 包失败，继续传输。`, details: { uploadId, error: safeUploadError(error) } }));
    await sandbox.files.remove(checksumPath).catch(error => reportProgress({ stage: 'transfer.remote-cleanup.warning', level: 'warning', message: '删除旧 runtime 校验文件失败，继续传输。', details: { uploadId, error: safeUploadError(error) } }));
    await reportProgress({ stage: 'transfer.remote-cleanup.complete', level: 'info', message: 'microVM 临时目标已准备好。', details: { uploadId } });
    let nextChunk = 0;
    let completedChunks = 0;
    const uploadedChunkBytes = new Array<number>(chunkCount).fill(0);
    const uploadWorker = async (): Promise<void> => {
      while (true) {
        const index = nextChunk++;
        if (index >= chunkCount) return;
        const start = index * uploadChunkBytes;
        const end = Math.min(start + uploadChunkBytes, bytes.byteLength);
        let uploadedPath = '';
        for (let attempt = 1; attempt <= uploadMaxAttempts; attempt += 1) {
          const partPath = `/tmp/csa-dsh-runtime-${uploadId}.part-${String(index).padStart(3, '0')}-attempt-${attempt}`;
          temporaryPartPaths.push(partPath);
          const attemptStartedAt = Date.now();
          await reportProgress({
            stage: 'chunk.write.start',
            level: 'info',
            message: `开始上传 ${runtimeLabel} 分片 ${index + 1}/${chunkCount}（第 ${attempt}/${uploadMaxAttempts} 次尝试）。`,
            details: { uploadId, chunkIndex: index + 1, chunkCount, attempt, maxAttempts: uploadMaxAttempts, byteStart: start, byteEndExclusive: end, chunkBytes: end - start, path: partPath },
          });
          let heartbeatCount = 0;
          const chunkHeartbeat = setInterval(() => {
            heartbeatCount += 1;
            void reportProgress({
              stage: 'chunk.write.heartbeat',
              level: 'info',
              message: `${runtimeLabel} 分片 ${index + 1}/${chunkCount} 上传仍在进行。`,
              details: { uploadId, chunkIndex: index + 1, chunkCount, attempt, bytes: end - start, elapsedMs: Date.now() - attemptStartedAt, heartbeatCount },
            }).catch(() => undefined);
          }, 30_000);
          chunkHeartbeat.unref();
          try {
            await sandbox.files.write(partPath, bytes.subarray(start, end));
            uploadedPath = partPath;
            clearInterval(chunkHeartbeat);
            await reportProgress({
              stage: 'chunk.write.success',
              level: 'info',
              message: `${runtimeLabel} 分片 ${index + 1}/${chunkCount} 上传成功。`,
              details: { uploadId, chunkIndex: index + 1, chunkCount, attempt, bytes: end - start, path: partPath },
              durationMs: Date.now() - attemptStartedAt,
            });
            break;
          } catch (error) {
            clearInterval(chunkHeartbeat);
            const retryable = isRetryableRuntimeUploadError(error);
            const details = { uploadId, chunkIndex: index + 1, chunkCount, attempt, maxAttempts: uploadMaxAttempts, bytes: end - start, path: partPath, retryable, error: safeUploadError(error) };
            if (attempt === uploadMaxAttempts || !retryable) {
              await reportProgress({ stage: 'chunk.write.failed', level: 'error', message: `${runtimeLabel} 分片 ${index + 1}/${chunkCount} 上传失败。`, details, durationMs: Date.now() - attemptStartedAt });
              throw error;
            }
            const retryDelayMs = Math.round(Math.min(20_000, 2_000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
            await reportProgress({ stage: 'chunk.write.retry', level: 'warning', message: `${runtimeLabel} 分片 ${index + 1}/${chunkCount} 上传失败，将在 ${retryDelayMs} ms 后重试第 ${attempt + 1}/${uploadMaxAttempts} 次。`, details: { ...details, retryDelayMs, nextAttempt: attempt + 1 }, durationMs: Date.now() - attemptStartedAt });
            await delay(retryDelayMs);
          }
        }
        if (!uploadedPath) throw new Error(runtimeLabel + ' runtime 依赖包第 ' + (index + 1) + ' 块未能上传。');
        await assertSandboxDidNotRestart();
        assemblyPartPaths[index] = uploadedPath;
        completedChunks += 1;
        uploadedChunkBytes[index] = end - start;
        const bytesUploaded = uploadedChunkBytes.reduce((sum, chunkBytes) => sum + chunkBytes, 0);
        const percent = Math.floor((bytesUploaded / bytes.byteLength) * 100);
        await reportProgress({ stage: 'chunk.upload.progress', level: 'info', message: `${runtimeLabel} 分片上传完成：${completedChunks}/${chunkCount} 块，累计 ${percent}%。`, details: { uploadId, completedChunks, chunkCount, currentChunk: index + 1, percent, bytesUploaded, totalBytes: bytes.byteLength } });
      }
    };
    const uploadResults = await Promise.allSettled(
      Array.from({ length: Math.min(uploadConcurrency, chunkCount) }, () => uploadWorker()),
    );
    const uploadFailure = uploadResults.find(result => result.status === 'rejected');
    if (uploadFailure?.status === 'rejected') throw uploadFailure.reason;

    const assemblyScript = [
      '#!/usr/bin/env bash',
      'set +e',
      'archive=' + shellQuote(archivePath),
      'archive_tmp=' + shellQuote(`${archivePath}.tmp-${uploadId}`),
      'checksum=' + shellQuote(bundle.archiveSha256),
      'expected_size=' + String(bundle.size),
      'status_file=' + shellQuote(assemblyExitPath),
      'log_file=' + shellQuote(assemblyLogPath),
      'parts=(' + assemblyPartPaths.map(shellQuote).join(' ') + ')',
      '(',
      '  set -Eeuo pipefail',
      '  : > "$archive_tmp"',
      '  index=0',
      '  for part in "${parts[@]}"; do',
      '    cat "$part" >> "$archive_tmp"',
      '    index=$((index + 1))',
      '    if (( index % 4 == 0 || index == ${#parts[@]} )); then printf "csa_bundle_assembly %s/%s\\n" "$index" "${#parts[@]}"; fi',
      '  done',
      '  actual_size="$(wc -c < "$archive_tmp")"',
      '  if [[ "$actual_size" -ne "$expected_size" ]]; then echo "archive size mismatch: $actual_size" >&2; exit 42; fi',
      '  printf "%s  %s\\n" "$checksum" "$archive_tmp" | sha256sum -c -',
      '  mv "$archive_tmp" "$archive"',
      '  printf "%s\\n" "$checksum" > "${archive}.sha256"',
      ') 2> "$log_file"',
      'status=$?',
      'if [[ "$status" -ne 0 ]]; then rm -f "$archive_tmp" "$archive" "${archive}.sha256"; fi',
      `rm -f ${assemblyPartPaths.map(shellQuote).join(' ')} "$status_file"`,
      'printf "%s\\n" "$status" > "$status_file"',
      'exit "$status"',
      '',
    ].join('\n');

    await reportProgress({ stage: 'assembly.script.write.start', level: 'info', message: '写入 microVM 内的 runtime 拼接与 SHA-256 校验脚本。', details: { uploadId, partCount: assemblyPartPaths.length, scriptBytes: Buffer.byteLength(assemblyScript), scriptPath: assemblyScriptPath } });
    await sandbox.files.write(assemblyScriptPath, assemblyScript);
    await reportProgress({ stage: 'assembly.script.write.complete', level: 'info', message: 'runtime 拼接脚本已写入 microVM。', details: { uploadId, scriptBytes: Buffer.byteLength(assemblyScript) } });
    await reportProgress({ stage: 'assembly.start', level: 'info', message: '启动 microVM 内的 runtime 拼接和 SHA-256 校验。', details: { uploadId, partCount: assemblyPartPaths.length, expectedBytes: bundle.size, expectedSha256: bundle.archiveSha256 } });
    const assemblyHandle = await startGuestPty(sandbox, `exec bash ${shellQuote(assemblyScriptPath)}`, '/tmp', {}, true);
    await reportProgress({ stage: 'assembly.process.started', level: 'info', message: '拼接进程已启动，等待大小和 SHA-256 校验结果。', details: { uploadId } });

    const assemblyStartedAt = Date.now();
    const assemblyDeadline = assemblyStartedAt + assemblyTimeoutMs;
    const assemblyOutputDecoder = new TextDecoder();
    let assemblyOutputPending = '';
    let assemblyOutputBytes = 0;
    let assemblyOutputQueue = Promise.resolve();
    const assemblyCompletion = assemblyHandle.wait(chunk => {
      const text = assemblyOutputDecoder.decode(chunk, { stream: true });
      assemblyOutputBytes += Buffer.byteLength(text);
      assemblyOutputPending += text;
      const lines = assemblyOutputPending.split(/\r?\n/);
      assemblyOutputPending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        assemblyOutputQueue = assemblyOutputQueue.then(() => reportProgress({
          stage: 'assembly.output',
          level: 'info',
          message: line.slice(0, 500),
          details: { uploadId, outputBytes: assemblyOutputBytes },
        })).catch(() => undefined);
      }
    }).then(
      exitCode => ({ exitCode }),
      error => ({ error }),
    );
    let assemblyOutcome = await Promise.race([assemblyCompletion, delay(30_000).then(() => null)]);
    let lastAssemblyProgressAt = Date.now();
    while (Date.now() < assemblyDeadline && assemblyOutcome === null) {
      await assertSandboxDidNotRestart();
      if (Date.now() - lastAssemblyProgressAt >= 30_000) {
        const elapsedSeconds = Math.floor((Date.now() - assemblyStartedAt) / 1000);
        await reportProgress({ stage: 'assembly.progress', level: 'info', message: `microVM 正在拼接并校验依赖包，已运行 ${elapsedSeconds} 秒。`, details: { uploadId, elapsedSeconds } });
        lastAssemblyProgressAt = Date.now();
      }
      assemblyOutcome = await Promise.race([assemblyCompletion, delay(30_000).then(() => null)]);
    }
    if (assemblyOutcome === null) {
      await assemblyHandle.kill().catch(() => false);
      throw new Error(`等待 microVM 拼接并校验依赖包超过 ${Math.round(assemblyTimeoutMs / 60_000)} 分钟。`);
    }
    if ('error' in assemblyOutcome) {
      const message = `microVM 内依赖包拼接进程异常退出：${safeUploadError(assemblyOutcome.error)}`;
      await reportProgress({ stage: 'assembly.process.failed', level: 'error', message, details: { uploadId, error: safeUploadError(assemblyOutcome.error) } });
      throw new Error(message);
    }
    if (assemblyOutcome.exitCode !== 0) {
      const log = await sandbox.files.read(assemblyLogPath).catch(() => '');
      const message = `microVM 内依赖包拼接进程退出码为 ${assemblyOutcome.exitCode}${log.trim() ? ': ' + log.trim().slice(-500) : '.'}`;
      await reportProgress({ stage: 'assembly.process.failed', level: 'error', message, details: { uploadId, exitCode: assemblyOutcome.exitCode, guestLogTail: log.trim().slice(-1200) } });
      throw new Error(message);
    }
    const remainingAssemblyOutput = assemblyOutputDecoder.decode() + assemblyOutputPending;
    if (remainingAssemblyOutput.trim()) {
      assemblyOutputQueue = assemblyOutputQueue.then(() => reportProgress({
        stage: 'assembly.output',
        level: 'info',
        message: remainingAssemblyOutput.trim().slice(0, 500),
        details: { uploadId, outputBytes: assemblyOutputBytes },
      })).catch(() => undefined);
    }
    await assemblyOutputQueue;
    await reportProgress({ stage: 'assembly.process.complete', level: 'info', message: 'microVM runtime 拼接进程已退出。', details: { uploadId, exitCode: assemblyOutcome.exitCode, outputBytes: assemblyOutputBytes }, durationMs: Date.now() - assemblyStartedAt });
    assemblyHandle.disconnect();

    while (Date.now() < assemblyDeadline) {
      if (await sandbox.files.exists(assemblyExitPath)) {
        const result = (await sandbox.files.read(assemblyExitPath)).trim();
        if (result !== '0') {
          const log = await sandbox.files.read(assemblyLogPath).catch(() => '');
          const message = `microVM 内依赖包拼接或 SHA-256 校验失败${log.trim() ? ': ' + log.trim().slice(-500) : '.'}`;
          await reportProgress({ stage: 'assembly.check.failed', level: 'error', message, details: { uploadId, exitCode: result, guestLogTail: log.trim().slice(-1200) } });
          throw new Error(message);
        }
        const [archive, checksum] = await Promise.all([
          sandbox.files.stat(archivePath),
          sandbox.files.read(checksumPath),
        ]);
        if (Number(archive.size) !== bundle.size || checksum.trim() !== bundle.archiveSha256) {
          const message = 'microVM 内拼接后的依赖包大小或 SHA-256 不匹配。';
          await reportProgress({ stage: 'assembly.check.failed', level: 'error', message, details: { uploadId, actualBytes: Number(archive.size), expectedBytes: bundle.size, actualSha256: checksum.trim(), expectedSha256: bundle.archiveSha256 } });
          throw new Error(message);
        }
        await reportProgress({ stage: 'assembly.check.passed', level: 'info', message: 'microVM 内依赖包已拼接并通过大小与 SHA-256 校验。', details: { uploadId, bytes: Number(archive.size), sha256: checksum.trim() } });
        await reportProgress({ stage: 'transfer.complete', level: 'info', message: `${runtimeLabel} 包传输和校验全部完成。`, details: { uploadId, bytes: bundle.size, sha256: bundle.archiveSha256 } });
        return;
      }
      await delay(2_000);
    }
    throw new Error('microVM 内拼接进程已退出，但没有写入结果标记。');
  } catch (error) {
    await reportProgress({ stage: 'transfer.failed', level: 'error', message: `${runtimeLabel} 包传输失败。`, details: { uploadId, error: safeUploadError(error) } }).catch(() => undefined);
    await sandbox.files.remove(archivePath).catch(() => undefined);
    await sandbox.files.remove(checksumPath).catch(() => undefined);
    throw error;
  } finally {
    // Do not close the PTY while the process is live: Cube terminates the
    // attached process group on disconnect. Normal completion has consumed
    // the PTY stream above; cleanup is then safe.
    await Promise.all([...temporaryPartPaths, assemblyScriptPath, assemblyExitPath, assemblyLogPath]
      .map(path => sandbox.files.remove(path).catch(() => undefined)));
  }
}

function isRetryableRuntimeUploadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|\b(?:HTTP\s+)?50[0-4]\b/i.test(message);
}

function safeUploadError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|api_key|apikey|secret|password)=)[^&\s]+/gi, '$1[redacted]');
  return `${error instanceof Error ? error.name : 'Error'}: ${message}`.slice(0, 1800);
}

function restartMarker(info: Record<string, unknown>): string {
  const status = info.restartStatus && typeof info.restartStatus === 'object'
    ? info.restartStatus as Record<string, unknown>
    : {};
  return String(status.restartCount ?? '') + '|' + String(status.lastRestartAt ?? '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
