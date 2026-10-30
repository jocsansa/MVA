# MVA — WING Remote

Controle da Behringer WING pela rede, com interface no navegador, para a equipe de som da igreja.
Produto e escopo: [PRODUCT.md](PRODUCT.md). Uso, protocolo e rotas: [README.md](README.md).
Detalhes: [arquitetura](docs/architecture.md), [design](docs/design.md), [qualidade](docs/quality.md),
[setup do toolkit](docs/setup.md).

## Regras de segurança (não negociáveis)

- **Mesa real: perguntar antes de QUALQUER escrita**, uma por vez, mostrando o comando exato e o
  aviso de risco (`dryRun`). Ler não precisa de pergunta. Na dúvida se é a mesa real, pergunte.
- Desenvolver e testar na **mesa simulada** (`CONSOLE_HOST=127.0.0.1`). O servidor só escreve com
  `WING_ALLOW_WRITES=1`; sem isso é somente leitura.
- Gravação de sessões e alertas são **só leitura**: nunca enviam comando para a mesa.
- Trabalhar só dentro desta pasta. Não modificar outros projetos (automix, openreply, qteste x32);
  o automix pode ser **lido** para reaproveitar desenho.
- Não fazer commit nem push sem pedido explícito.

## Comandos

No Windows use `npm.cmd` (o PowerShell bloqueia `npm.ps1`). Node ≥ 22.18, TypeScript roda direto
(sem build).

- Instalar: `npm install`
- Mesa simulada: `npm run simulate` (terminal 1)
- Servidor: `CONSOLE_HOST=127.0.0.1 npm start` (terminal 2; porta 3000, `PORT` muda)
- Tipos: `npm run typecheck` · Lint: `npm run lint` · Regras de lint: `npm run verify:rules`
- Testes: `npm test` (node:test, `test/**/*.test.ts`)
- Tudo junto: `npm run check` (tipos + lint + regras + testes)
- Página no navegador: `npm run smoke` (Chrome headless, servidor rodando; só olha, não clica em
  controles da mesa)
- Achar a mesa real: `npm run discover`

## Combinados de trabalho

- Ler o código e as instruções relevantes antes de editar; separar observação, suposição e decisão.
- Definir critério de aceite e checagem antes de implementar. Correção de bug: reproduzir e deixar
  teste de regressão quando der.
- Menor mudança completa; reaproveitar padrões e módulos existentes; sem dependência de execução nova
  sem decisão explícita (hoje o app não tem nenhuma).
- Não afrouxar lint, testes, validação das escritas nem avisos de risco para fazer passar.
- Comportamento novo da WING real só vira fato depois de testado na mesa; registrar em
  "Testado na mesa real" no README. Até lá, marcar como pendente.
- Atualizar o documento responsável junto com a mudança (README para rotas e uso, docs/ para o resto).
- Interface em português (pt-BR), código e comentários em português, como o resto do projeto.
- Trabalho que atravessa sessões: handoff curto com estado verificado e próxima ação (veja
  docs/quality.md); ao retomar, conferir arquivos, git e processos antes de confiar nele.

## Ferramentas

- **Superpowers / Ponytail (full) / Caveman:** plugins do Claude Code instalados no usuário. Processo
  proporcional ao tamanho do pedido; instrução explícita do usuário vale mais que repetir aprovação.
  Caveman só na conversa; código, docs e commits em texto normal.
- **Context7:** conectado (veja docs/setup.md). Sem ele, usar documentação oficial e registrar.
- **Subagentes:** só quando isolar contexto ou paralelizar trabalho independente compensar. Modelo
  mais leve para buscas e inventário; capacidade maior para escrita na mesa, segurança e revisão.
  Um escritor por arquivo; o coordenador confere o diff e roda `npm run check`.
- **Revisão:** mudanças não triviais têm revisão por risco (veja docs/quality.md). Segurança:
  `/security-review` ou o prompt em docs/security-review.md.
