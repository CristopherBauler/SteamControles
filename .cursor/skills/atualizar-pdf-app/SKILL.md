---
name: atualizar-pdf-app
description: >-
  Atualiza o PDF técnico do app Minha Loja dos Desejos (Docs/como-o-app-foi-feito.html
  e npm run docs:pdf) quando a arquitetura, sync, persistência ou camadas do app mudarem.
---

# Atualizar o PDF técnico

Fonte: `Docs/como-o-app-foi-feito.html`. PDF gerado: `Docs/Como o app foi feito.pdf`.

Quando mudar fluxo de dados, pastas, timers, persistência, Electron/Capacitor ou como terceiros usam o app:

1. Edite o HTML (passo a passo, linguagens, tabelas). Acrescente uma linha em **Histórico deste documento**.
2. Rode `npm run docs:pdf` na raiz do repo para gerar o PDF **só na máquina local**.
3. Não reescreva o PDF à mão. Não despeje changelog de CSS.
4. **Nunca commite** `Docs/Como o app foi feito.pdf`. O HTML pode ir no git; o PDF não. Ele está no `.gitignore`.

O usuário pediu um PDF local que o agente atualiza conforme o trabalho avança, sem versionar o binário.
