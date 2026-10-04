#!/usr/bin/env sh
set -eu

fail=0
check() { if "$@" >/dev/null 2>&1; then printf 'PASS  %s\n' "$*"; else printf 'FAIL  %s\n' "$*"; fail=1; fi; }

printf 'Architecture benchmark Ubuntu preflight\n'
check test "$(uname -s)" = Linux
check command -v docker
check docker compose version
check docker info

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)"
memory_kib="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || printf 0)"
disk_kib="$(df -Pk . | awk 'NR==2{print $4}')"
open_files="$(ulimit -n)"
printf 'INFO  logical CPUs: %s (8+ recommended for the evaluator host)\n' "$cpu_count"
printf 'INFO  memory: %s MiB (16384+ MiB recommended)\n' "$((memory_kib / 1024))"
printf 'INFO  free workspace disk: %s GiB (100+ GiB recommended)\n' "$((disk_kib / 1024 / 1024))"
printf 'INFO  open-file limit: %s (65535+ recommended)\n' "$open_files"

if [ "$cpu_count" -lt 4 ] || [ "$memory_kib" -lt 8388608 ] || [ "$disk_kib" -lt 20971520 ] || [ "$open_files" -lt 16384 ]; then
  printf 'FAIL  host resources are below the minimum safe screening baseline\n'
  fail=1
fi

if [ -r /proc/sys/net/core/somaxconn ]; then
  printf 'INFO  net.core.somaxconn: %s\n' "$(cat /proc/sys/net/core/somaxconn)"
fi
if [ -r /proc/sys/net/ipv4/ip_local_port_range ]; then
  printf 'INFO  ip_local_port_range: %s\n' "$(cat /proc/sys/net/ipv4/ip_local_port_range)"
fi

exit "$fail"
