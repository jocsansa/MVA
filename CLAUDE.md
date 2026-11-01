@AGENTS.md

## Claude Code

- Shell: no Windows o Bash é Git Bash e o PowerShell é 5.1; rode `npm.cmd`, não `npm`. No macOS
  (Mac da igreja) é `npm` normal e zsh/bash.
- **Mac da igreja: "rodar MVA"** = seguir [docs/mac.md](docs/mac.md) ("Rodar MVA"): atualizar,
  instalar se for a primeira vez, achar a mesa e subir em segundo plano com `scripts/mac/mva.sh`,
  somente leitura, acesso pelo celular com a senha do `.env`.
- Simulador e servidor em segundo plano (dois processos). Antes de reiniciar, pare o processo que
  você mesmo iniciou; não mate processos que não criou. No Mac, o servidor é do `scripts/mac/mva.sh`
  (`parar`/`fundo`).
- Comandar a mesa pelo chat: siga "Comandar pelo chat (Claude Code)" no README — `dryRun` primeiro,
  pergunta ao usuário, uma escrita por vez, informar a leitura de volta.
- Memória do Claude para este projeto fica por máquina (no PC:
  `~/.claude/projects/c--users-jocsa-documents-mva/memory/`). Regras do projeto ficam aqui no
  repositório, não na memória.
