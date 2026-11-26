import { Sandbox } from '@cubesandbox/sdk';
import { pool } from '../../src/server/db.ts';
import { cubeConfig } from '../../src/server/computer.ts';
import { decryptSandboxTrafficToken } from '../../src/server/token-crypto.ts';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const tenantId = process.env.CSA_DIAGNOSTIC_TENANT_ID;
if (!tenantId) throw new Error('Set CSA_DIAGNOSTIC_TENANT_ID to an existing tenant UUID.');

const [rows] = await pool.query(
  'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state FROM computers WHERE tenant_id = ? LIMIT 1',
  [tenantId],
);
await pool.end();

const computer = (rows as Array<{
  sandbox_id: string | null;
  cube_traffic_token_ciphertext: string | null;
  state: string;
  desktop_state: string;
}>)[0];
if (!computer?.sandbox_id || computer.state !== 'running' || !computer.cube_traffic_token_ciphertext) {
  throw new Error('The selected tenant must have a running microVM and a stored traffic token.');
}

let sandbox = await Sandbox.connect(computer.sandbox_id, { config: cubeConfig() });
if (!sandbox.trafficAccessToken) {
  const authenticated = new Sandbox({
    sandboxID: sandbox.sandboxId,
    templateID: sandbox.templateId,
    domain: sandbox.domain,
    trafficAccessToken: decryptSandboxTrafficToken(computer.cube_traffic_token_ciphertext),
    envdAccessToken: sandbox.envdAccessToken,
  }, sandbox.config);
  sandbox.close();
  sandbox = authenticated;
}

const command = String.raw`
set +e
static_pid=
web_pid=
stop_pid() {
  local pid="$1" attempt
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for attempt in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  stop_pid "$web_pid"
  stop_pid "$static_pid"
}
trap cleanup EXIT

/usr/bin/python3 -m http.server 16081 --bind 127.0.0.1 --directory /usr/share/novnc >/tmp/csa-http-compare-python.log 2>&1 &
static_pid=$!
sleep 3
static_out="$(curl --noproxy '*' -sS --connect-timeout 1 --max-time 5 -o /dev/null -w 'http_code=%{http_code} bytes=%{size_download} time=%{time_total}' http://127.0.0.1:16081/vnc.html 2>&1)"
static_status=$?
printf 'STATIC status=%s result=%s\n' "$static_status" "$static_out"
stop_pid "$static_pid"
static_pid=

/usr/bin/websockify --web=/usr/share/novnc 16082 localhost:5900 >/tmp/csa-http-compare-websockify.log 2>&1 &
web_pid=$!
port_hex="$(printf '%04X' 16082)"
web_listener=0
for attempt in $(seq 1 90); do
  if awk -v port="$port_hex" '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) found=1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    web_listener=1
    printf 'WEBSOCKIFY_LISTENER attempt=%s elapsed_seconds=%s\n' "$attempt" "$attempt"
    break
  fi
  if ((attempt % 15 == 0)); then
    process_state="$(awk '/^State:/ { print $2 }' "/proc/$web_pid/status" 2>/dev/null)"
    process_rss="$(awk '/^VmRSS:/ { print $2 }' "/proc/$web_pid/status" 2>/dev/null)"
    process_ticks="$(awk '{ print $14 + $15 }' "/proc/$web_pid/stat" 2>/dev/null)"
    if [[ -z "$process_state" ]]; then process_state=absent; fi
    if [[ -z "$process_rss" ]]; then process_rss=unknown; fi
    if [[ -z "$process_ticks" ]]; then process_ticks=unknown; fi
    printf 'WEBSOCKIFY_STARTUP attempt=%s state=%s rss_kb=%s cpu_ticks=%s\n' "$attempt" "$process_state" "$process_rss" "$process_ticks"
  fi
  sleep 1
done
if [[ "$web_listener" == 1 ]]; then
  web_out="$(curl --noproxy '*' -sS --connect-timeout 1 --max-time 5 -o /dev/null -w 'http_code=%{http_code} bytes=%{size_download} time=%{time_total}' http://127.0.0.1:16082/vnc.html 2>&1)"
  web_status=$?
  printf 'WEBSOCKIFY_HTTP status=%s result=%s\n' "$web_status" "$web_out"
  close_out="$(curl --noproxy '*' -H 'Connection: close' -sS --connect-timeout 1 --max-time 5 -o /dev/null -w 'http_code=%{http_code} bytes=%{size_download} time=%{time_total}' http://127.0.0.1:16082/vnc.html 2>&1)"
  close_status=$?
  printf 'WEBSOCKIFY_HTTP_CLOSE status=%s result=%s\n' "$close_status" "$close_out"
else
  printf 'WEBSOCKIFY_LISTENER timeout_seconds=90\n'
fi
printf 'WEBSOCKIFY_LOG_BEGIN\n'
tail -n 8 /tmp/csa-http-compare-websockify.log
printf 'WEBSOCKIFY_LOG_END\n'
stop_pid "$web_pid"
web_pid=

for port in 16081 16082; do
  port_hex="$(printf '%04X' "$port")"
  rows="$(awk -v port="$port_hex" '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) print $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)"
  if [[ -z "$rows" ]]; then rows=none; fi
  printf 'PORT port=%s listeners=%s\n' "$port" "$rows"
done
`;

try {
  const result = await runGuestPty(sandbox, command, '/', {}, undefined, 120_000);
  const outputLines = result.output
    .split(/\r?\n/)
    .map(line => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim())
    .filter(line => /^(STATIC|WEBSOCKIFY|PORT|WebSocket server settings|  - Listen|  - Web server|  - proxying|handler exception)/.test(line));
  process.stdout.write(JSON.stringify({ exitCode: result.exitCode, outputLines }) + '\n');
} finally {
  sandbox.close();
}
