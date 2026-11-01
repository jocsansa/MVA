#!/bin/bash
# MVA no Mac da igreja: instalar, achar a mesa, rodar o servidor com acesso pelo celular.
#
#   scripts/mac/mva.sh instalar    confere o Node, instala dependências, roda as checagens e cria o .env
#   scripts/mac/mva.sh achar       procura a WING em todas as redes do Mac e grava o IP no .env
#   scripts/mac/mva.sh iniciar     roda o servidor aqui no terminal (Ctrl+C para parar)
#   scripts/mac/mva.sh fundo       roda em segundo plano (continua se fechar o terminal)
#   scripts/mac/mva.sh parar       para o servidor em segundo plano
#   scripts/mac/mva.sh status      diz se está rodando, se a mesa responde e os endereços do celular
#   scripts/mac/mva.sh log         últimas linhas do log (data/logs/servidor.log)
#   scripts/mac/mva.sh atualizar   puxa a versão nova do GitHub (recusa se houver mudança local)
#
# Configuração em .env na pasta do projeto (fora do git):
#   CONSOLE_HOST       IP da WING (o "achar" preenche)
#   ACCESS_PIN         senha do celular (o "instalar" gera 6 dígitos)
#   PORT               porta da página (3000)
#   WING_ALLOW_WRITES  0 = somente leitura (padrão); 1 = a página pode mudar a mesa
#   LISTEN_HOST        0.0.0.0 = celulares na rede (padrão aqui); 127.0.0.1 = só este Mac
#
# Enquanto roda, o Mac não dorme (caffeinate). O servidor reinicia sozinho se cair.
# Este script nunca envia comando para a mesa: só sobe o servidor (somente leitura por padrão).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
LOG_DIR="$ROOT/data/logs"
LOG_FILE="$LOG_DIR/servidor.log"
PID_FILE="$ROOT/data/mva.pid"
NODE_MIN="22.18"

say() { printf '%s\n' "$*"; }
die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

# Grava KEY=VALUE no .env (troca a linha se existir). Sem sed -i (diferente no Mac e no Linux).
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true; fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "falta o .env. Rode: scripts/mac/mva.sh instalar"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  PORT="${PORT:-3000}"
  LISTEN_HOST="${LISTEN_HOST:-0.0.0.0}"
  WING_ALLOW_WRITES="${WING_ALLOW_WRITES:-0}"
  export PORT LISTEN_HOST WING_ALLOW_WRITES
}

check_node() {
  if ! command -v node > /dev/null 2>&1; then
    say "Node.js não encontrado. Instale o Node 22.18 ou mais novo:"
    say "  com Homebrew:  brew install node"
    say "  ou o instalador LTS em https://nodejs.org"
    exit 1
  fi
  local v
  v="$(node -p 'process.versions.node')"
  if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)"; then
    say "Node $v é antigo; o MVA precisa do $NODE_MIN ou mais novo."
    say "  com Homebrew:  brew upgrade node   (ou brew install node)"
    say "  ou o instalador LTS em https://nodejs.org"
    exit 1
  fi
  say "Node $v ok."
}

server_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  kill -0 "$pid" 2> /dev/null || return 1
  printf '%s' "$pid"
}

urls() {
  node --input-type=module -e "const m = await import('./src/access.ts'); console.log(m.lanUrls(Number(process.argv[1])).join('\n'))" "$PORT"
}

cmd_instalar() {
  [ "$(uname)" = "Darwin" ] || say "Aviso: este script foi feito para o macOS; seguindo mesmo assim."
  check_node
  say "Instalando dependências (npm ci)..."
  npm ci --no-audit --no-fund
  say "Checagens (tipos, lint, testes)..."
  npm run check
  if [ ! -f "$ENV_FILE" ]; then
    local pin
    pin="$(node -p "require('node:crypto').randomInt(0, 1e6).toString().padStart(6, '0')")"
    set_env CONSOLE_HOST ""
    set_env ACCESS_PIN "$pin"
    set_env PORT 3000
    set_env WING_ALLOW_WRITES 0
    set_env LISTEN_HOST 0.0.0.0
    say ".env criado. Senha do celular: $pin"
  else
    say ".env já existe; mantido."
  fi
  say "Próximo passo: scripts/mac/mva.sh achar  (com o Mac na rede da mesa)"
}

cmd_achar() {
  check_node
  # Broadcast em cada rede do Mac (Wi-Fi e cabo), mais o geral.
  local targets found ips
  targets="$( (ifconfig 2> /dev/null | awk '/inet .* broadcast/ {print $NF}'; echo 255.255.255.255) | sort -u)"
  found=""
  for t in $targets; do
    found="$found$(node src/discover.ts "$t" | grep 'WING encontrada' || true)"$'\n'
  done
  ips="$(printf '%s' "$found" | sed -n 's/^WING encontrada em \([0-9.]*\):.*/\1/p' | sort -u)"
  if [ -z "$ips" ]; then
    die "nenhuma WING respondeu. Confira o cabo/rede da mesa e se o macOS deixou o Terminal acessar a rede local (Ajustes > Privacidade e Segurança > Rede Local)."
  fi
  printf '%s' "$found" | grep -v '^$' | sort -u
  if [ "$(printf '%s\n' "$ips" | wc -l | tr -d ' ')" != "1" ]; then
    say "Mais de uma WING. Escolha e grave com: scripts/mac/mva.sh usar <ip>"
    return 0
  fi
  set_env CONSOLE_HOST "$ips"
  say "CONSOLE_HOST=$ips gravado no .env."
}

cmd_usar() {
  [ -n "${1:-}" ] || die "uso: scripts/mac/mva.sh usar <ip-da-wing>"
  set_env CONSOLE_HOST "$1"
  say "CONSOLE_HOST=$1 gravado no .env."
}

# Laço do servidor: reinicia se cair; desiste se cair 3 vezes logo depois de subir.
cmd_iniciar() {
  check_node
  load_env
  [ -n "${CONSOLE_HOST:-}" ] || die "CONSOLE_HOST vazio no .env. Rode: scripts/mac/mva.sh achar"
  if pid="$(server_pid)" && [ "$pid" != "$$" ]; then die "já está rodando (pid $pid). Use: scripts/mac/mva.sh parar"; fi
  mkdir -p "$LOG_DIR"
  echo $$ > "$PID_FILE"
  local stop=0 child=0 fast=0 t0 code
  trap 'stop=1; if [ "$child" -gt 0 ]; then kill -TERM "$child" 2> /dev/null || true; fi' INT TERM
  [ "$WING_ALLOW_WRITES" = "1" ] && say "ATENÇÃO: escrita liberada (WING_ALLOW_WRITES=1): a página pode mudar a mesa."
  say "Mesa: $CONSOLE_HOST · porta $PORT · celular (mesma rede, senha do .env):"
  urls | sed 's/^/  /'
  while [ "$stop" -eq 0 ]; do
    t0=$SECONDS
    node src/server.ts &
    child=$!
    if command -v caffeinate > /dev/null 2>&1; then caffeinate -is -w "$child" & fi
    set +e
    wait "$child"
    code=$?
    while kill -0 "$child" 2> /dev/null; do wait "$child"; code=$?; done
    set -e
    child=0
    [ "$stop" -eq 0 ] || break
    if [ $((SECONDS - t0)) -lt 10 ]; then fast=$((fast + 1)); else fast=0; fi
    if [ "$fast" -ge 3 ]; then
      rm -f "$PID_FILE"
      die "o servidor caiu 3 vezes logo ao subir (código $code). Veja o erro acima ou: scripts/mac/mva.sh log"
    fi
    say "$(date '+%H:%M:%S') servidor saiu (código $code); reiniciando em 3 s..."
    sleep 3
  done
  rm -f "$PID_FILE"
  say "Servidor parado."
}

cmd_fundo() {
  if pid="$(server_pid)"; then die "já está rodando (pid $pid)."; fi
  load_env
  [ -n "${CONSOLE_HOST:-}" ] || die "CONSOLE_HOST vazio no .env. Rode: scripts/mac/mva.sh achar"
  mkdir -p "$LOG_DIR"
  nohup "$0" iniciar >> "$LOG_FILE" 2>&1 < /dev/null &
  sleep 3
  if server_pid > /dev/null; then
    say "Rodando em segundo plano. Log: $LOG_FILE"
    cmd_status
  else
    say "Não subiu. Últimas linhas do log:"
    tail -n 20 "$LOG_FILE"
    exit 1
  fi
}

cmd_parar() {
  local pid
  if ! pid="$(server_pid)"; then say "Não está rodando."; rm -f "$PID_FILE"; return 0; fi
  kill -TERM "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
  if kill -0 "$pid" 2> /dev/null; then die "o processo $pid não parou."; fi
  rm -f "$PID_FILE"
  say "Parado."
}

cmd_status() {
  load_env
  if pid="$(server_pid)"; then say "Rodando (pid $pid), mesa $CONSOLE_HOST, porta $PORT."; else say "Não está rodando."; fi
  local state
  if state="$(curl -s --max-time 3 "http://localhost:$PORT/api/state")"; then
    node -e '
      const s = JSON.parse(process.argv[1]).status;
      const ok = s.lastOscAt && Date.now() - s.lastOscAt < 15000;
      console.log(ok ? `Mesa respondendo: ${s.consoleInfo ?? "sim"}` : `Mesa SEM resposta${s.error ? ": " + s.error : ""}`);
      console.log(s.writesEnabled ? "Escrita LIBERADA" : "Somente leitura");
    ' "$state" 2> /dev/null || say "Página respondeu, mas não deu para ler o estado."
    say "Celular (mesma rede):"
    urls | sed 's/^/  /'
  else
    say "Página não responde em http://localhost:$PORT."
  fi
}

cmd_log() { tail -n "${1:-80}" "$LOG_FILE"; }

cmd_atualizar() {
  git fetch origin
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    die "há mudanças locais; não vou sobrescrever. Resolva (commit/stash) e rode de novo."
  fi
  git pull --ff-only
  npm ci --no-audit --no-fund
  say "Atualizado: $(git log -1 --format='%h %s')"
  if server_pid > /dev/null; then say "O servidor está rodando com a versão antiga: scripts/mac/mva.sh parar && scripts/mac/mva.sh fundo"; fi
}

case "${1:-}" in
  instalar) cmd_instalar ;;
  achar) cmd_achar ;;
  usar) shift; cmd_usar "${1:-}" ;;
  iniciar) cmd_iniciar ;;
  fundo) cmd_fundo ;;
  parar) cmd_parar ;;
  status) cmd_status ;;
  log) shift; cmd_log "${1:-80}" ;;
  atualizar) cmd_atualizar ;;
  *) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
