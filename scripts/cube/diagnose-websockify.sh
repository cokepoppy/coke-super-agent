set +e

printf 'websockify.diag.path system_python=%s resolved=%s path_python=%s path_python_resolved=%s\n' \
  /usr/bin/python3 "$(readlink -f /usr/bin/python3 2>/dev/null || true)" \
  "$(command -v python3 2>/dev/null || true)" "$(readlink -f "$(command -v python3 2>/dev/null)" 2>/dev/null || true)"
grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null
nl -ba /usr/lib/python3.11/socket.py 2>/dev/null | sed -n '45,60p'

run_probe() {
  name="$1"
  shift
  output="/tmp/csa-websockify-diagnostic-$name.log"
  timeout --kill-after=1s 8s "$@" >"$output" 2>&1
  status=$?
  printf 'websockify.diag.result name=%s status=%s command=' "$name" "$status"
  printf '%q ' "$@"
  printf '\n'
  sed -n '1,20p' "$output"
}

run_probe_tail() {
  name="$1"
  shift
  output="/tmp/csa-websockify-diagnostic-$name.log"
  timeout --kill-after=1s 8s "$@" >"$output" 2>&1
  status=$?
  printf 'websockify.diag.result name=%s status=%s command=' "$name" "$status"
  printf '%q ' "$@"
  printf '\n'
  tail -n 55 "$output"
}

run_probe python311-version /usr/bin/python3 --version
run_probe python311-low-level-socket /usr/bin/python3 -S -c 'import _socket; print(getattr(_socket, "__file__", "<built-in-or-frozen>"))'
run_probe python311-socket-module /usr/bin/python3 -S -c 'import socket; print(socket.__file__)'
run_probe python311-site-config /usr/bin/python3 -c 'import site,sys; print("executable=" + sys.executable); print("prefix=" + sys.prefix); print("site=" + repr(site.getsitepackages())); print("path=" + repr(sys.path))'
run_probe python311-site-socket /usr/bin/python3 -c 'import socket; print(socket.__file__)'
run_probe python311-site-websockify-no-numpy /usr/bin/python3 -c 'import sys; sys.modules["numpy"] = None; import websockify; print(websockify.__file__)'
run_probe python311-nosite-websockify-no-numpy /usr/bin/python3 -S -c 'import sys; sys.modules["numpy"] = None; sys.path.insert(0, "/usr/lib/python3/dist-packages"); import websockify; print(websockify.__file__)'
run_probe python312-version /usr/local/bin/python3.12 --version
run_probe python312-low-level-socket /usr/local/bin/python3.12 -S -c 'import _socket; print(_socket.__file__)'
run_probe python312-socket-module /usr/local/bin/python3.12 -S -c 'import socket; print(socket.__file__)'
run_probe_tail python311-nosite-websockify-import-trace /usr/bin/python3 -S -v -c 'import faulthandler,sys; faulthandler.dump_traceback_later(3, repeat=True); sys.modules["numpy"] = None; sys.path.insert(0, "/usr/lib/python3/dist-packages"); import websockify; print(websockify.__file__)'
exit 0
