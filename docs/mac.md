# Mac da igreja

O MacBook da igreja roda o servidor do MVA ligado à rede da WING; a equipe abre a página pelo
celular, no Wi-Fi da igreja, com uma senha. O Mac só serve para rodar o servidor e configurar.

Tudo passa por `scripts/mac/mva.sh` (bash 3.2 do macOS, sem dependência nova). O app não tem
dependências de execução: no Mac basta o **Node 22.18 ou mais novo**; `npm ci` só traz as
ferramentas de checagem (TypeScript, ESLint).

## "Rodar MVA" (pedido curto para o Claude Code no Mac)

1. Conferir a pasta: `git status`, `git log -1`, e se o servidor já está rodando
   (`scripts/mac/mva.sh status`). Não sobrescrever mudança local.
2. Primeira vez na pasta: `scripts/mac/mva.sh instalar` (confere o Node, `npm ci`, `npm run check`,
   cria o `.env` com a senha do celular). Depois: `scripts/mac/mva.sh atualizar`.
3. Achar a mesa: `scripts/mac/mva.sh achar` (grava `CONSOLE_HOST` no `.env`). Mais de uma WING ou
   nenhuma: perguntar ao usuário e usar `scripts/mac/mva.sh usar <ip>`.
4. Subir em segundo plano: `scripts/mac/mva.sh fundo`, depois `scripts/mac/mva.sh status`.
5. Responder ao usuário com o endereço do celular, a senha (do `.env`) e se a mesa respondeu.

Sempre **somente leitura** (`WING_ALLOW_WRITES=0`). Liberar escrita é decisão do Jocsan, pedida
explicitamente; continua valendo a regra de perguntar antes de qualquer escrita pelo chat
(AGENTS.md).

## Comandos

| Comando | O que faz |
|---|---|
| `scripts/mac/mva.sh instalar` | Confere o Node, `npm ci`, `npm run check`, cria `.env` (senha de 6 dígitos) |
| `scripts/mac/mva.sh achar` | Procura a WING em todas as redes do Mac (Wi-Fi e cabo) e grava o IP |
| `scripts/mac/mva.sh usar <ip>` | Grava o IP da WING à mão |
| `scripts/mac/mva.sh iniciar` | Servidor no terminal (Ctrl+C para parar) |
| `scripts/mac/mva.sh fundo` | Servidor em segundo plano (segue com o terminal fechado) |
| `scripts/mac/mva.sh parar` / `status` / `log [n]` | Parar, estado (mesa respondendo? endereços), últimas linhas do log |
| `scripts/mac/mva.sh atualizar` | `git pull --ff-only` + `npm ci`; recusa se houver mudança local |

Enquanto roda, o Mac não dorme (`caffeinate -is` preso ao processo do servidor; a tela pode
apagar). Se o servidor cair, o script reinicia em 3 s; se cair 3 vezes logo ao subir, desiste e
mostra o erro. Log em `data/logs/servidor.log`, sessões em `data/sessions/` (fora do git).

## `.env` (na pasta do projeto, fora do git, permissão 600)

| Variável | Padrão no Mac | Para quê |
|---|---|---|
| `CONSOLE_HOST` | (o `achar` preenche) | IP da WING |
| `ACCESS_PIN` | 6 dígitos aleatórios | Senha do celular (mínimo 6 caracteres) |
| `PORT` | 3000 | Porta da página |
| `LISTEN_HOST` | 0.0.0.0 | Rede (celulares). `127.0.0.1` = só o Mac |
| `WING_ALLOW_WRITES` | 0 | 1 = a página pode mudar a mesa |

Trocar a senha: editar `ACCESS_PIN` e reiniciar (`parar` + `fundo`); os celulares pedem a senha de
novo.

## Celular

Mesma rede do Mac. Abrir o endereço que o `status` mostra (`http://<ip-do-mac>:3000` ou
`http://<nome-do-mac>.local:3000`), digitar a senha uma vez; o navegador guarda o acesso por 90
dias. No iPhone, "Adicionar à Tela de Início" deixa um atalho. Detalhes do modo rede no README
("Acesso pelo celular").

## Permissões do macOS (primeira vez)

- **Rede Local** (macOS 15+): o macOS pergunta se o Terminal (ou o app que rodou o script) pode
  achar dispositivos na rede local. Tem que **Permitir**; sem isso a WING não responde
  (Ajustes > Privacidade e Segurança > Rede Local).
- **Firewall**: se estiver ligado, aparece "aceitar conexões de entrada para node?". **Permitir**;
  sem isso o celular não abre a página.

## Migrar do PC de casa

O Mac tinha uma cópia antiga, do primeiro dia. A versão nova vai numa pasta nova
(`~/Documents/MVA-igreja`), clonada do GitHub; a pasta antiga fica como estava. O que existe só no
PC de casa (commits sem push, outros projetos, a memória do Claude Code em
`~/.claude/projects/c--users-jocsa-documents-mva/memory/`) precisa de push no PC antes de chegar
aqui. Plugins do Claude Code (Superpowers, Ponytail, Caveman) e a aprovação do Context7 são por
máquina: instalar/aprovar de novo no Mac se for usar (docs/setup.md).
