# Minha Loja dos Desejos

Controlador de valores da Steam: vê os preços da sua wishlist e dos jogos mais populares do momento no gg.deals e na Steam.

Dashboard local para o Obsidian: lê a **wishlist pública da Steam**, grava preços em **BRL** e monta um painel com promoções e histórico.

Você só adiciona ou remove jogos na Steam. O script detecta a mudança na próxima atualização.

## App no Windows (passar para alguém)

O jeito simples: `npm run app:build` e envie `dist/SteamControles.exe` (o nome do atalho é **Minha Loja dos Desejos**). A outra pessoa **não precisa** de Node, Obsidian nem backend. Abre o exe, **Entrar com Steam**, wishlist **pública**. Dados dela ficam em `%AppData%\Minha Loja dos Desejos` e uma cópia das marcações em `%AppData%\Roaming\MinhaLojaDosDesejos`.

O que ainda é “seu PC de dev”, não o pacote para amigo:

- Rodar da pasta do vault (`npm run app` / `.vbs`) usa o `Data/` desta pasta.
- O APK Android é outro arquivo (`npm run mobile:apk`). git push **não** atualiza o telefone. Mandar o APK debug exige “fontes desconhecidas”.
- Sem wishlist pública, Novidades/Wishlist vêm vazias. Jogos/família pedem Detalhes dos jogos públicos ou chave Web API.
- Celular fora da Wi‑Fi de casa **não** puxa marcações novas do PC (isso ainda é LAN). Depois do primeiro espelho, wishlist/loja atualizam pela Steam no próprio telefone.

Na pasta do projeto (você):

```bash
npm install
npm run app
```

## App no Windows (sem Obsidian)

Há um app portable com ícone na bandeja: wishlist/backlog no intervalo dos Ajustes, Loja a cada 30 min. Fechar a janela só esconde.

Gerar o `.exe`:

```bash
npm run app:build
```

O arquivo fica em `dist/SteamControles.exe`. Os dados de quem abre o exe ficam em `%AppData%\Minha Loja dos Desejos`.

Para abrir no dia a dia (pasta do projeto): `SteamControles.vbs` (sem janela de CMD), `SteamControles.cmd` / `SteamControles.bat`, ou `npm run app`. **Não fixe** o `.vbs` nem o `electron.exe` na barra — o Windows mostra “Windows Script Host” ou a tela genérica do Electron. No app, **Ajustes → Criar atalho na barra / área de trabalho**, depois fixe o atalho **Minha Loja dos Desejos**. Depois do `npm run app:build`, o alvo certo é `dist/SteamControles.exe`.

## Requisitos


- Windows 10/11
- [Node.js 18+](https://nodejs.org/)
- Obsidian com o plugin **Dataview** (ative *Enable JavaScript Queries*)
- Wishlist da Steam **pública** (Perfil → Privacidade → Lista de desejos)

Opcional: plugin **Obsidian Charts** para o gráfico na nota de cada jogo.

## Instalação

No terminal, nesta pasta:

```bash
copy config.example.json config.json
npm install
```

Não há dependências externas; o `npm install` só registra os scripts. O `config.example.json` vem **sem** SteamID — cada pessoa gera o próprio com o login.

## Configuração

O `config.json` fica só na sua máquina (está no `.gitignore`). Copie o exemplo e ajuste se quiser:

| Campo | O que é |
| --- | --- |
| `steamId` | Preenchido pelo `conectar-steam.bat` |
| `profileUrl` | Preenchido pelo login, ou a URL pública do perfil |
| `currency` | `BRL` |
| `updateHour` | Horário do Agendador, ex. `08:00` |
| `vaultPath` | Pasta do vault do Obsidian (vazio = pasta acima deste projeto) |
| `projectFolder` | Subpasta deste projeto dentro do vault (`Steam`) |
| `itadApiKey` | Opcional: chave [IsThereAnyDeal](https://isthereanydeal.com/) para preços de Nuuvem / GMG / Fanatical |
| `steamWebApiKey` | Opcional: chave da [Steam Web API](https://steamcommunity.com/dev/apikey). Sem ela, o backlog só vê o que o cliente Steam deste PC cacheou. **Biblioteca completa + Steam Family** pedem Detalhes dos jogos públicos **ou** essa chave. O `conectar-steam.bat` só grava o SteamID (OpenID); a chave é um passo extra. **Não** suba a chave nem o SteamID no git. |

A lista **precisa estar pública**. Sem isso a Steam devolve lista vazia.

## Conectar sua conta Steam

Não tem SteamID no repositório. Cada clone faz o login local:

1. Dê um duplo clique em `conectar-steam.bat`
2. O navegador abre o **Sign in through Steam** (oficial da Valve)
3. Você entra com sua conta (senha só na Steam; este projeto não vê)
4. O SteamID é gravado no **seu** `config.json`

A lista de desejos precisa estar **pública**: Perfil Steam → Privacidade → Lista de desejos. Sem isso a API da Valve não entrega os jogos, mesmo depois do login. Isso não deixa o perfil inteiro público.

Para o **backlog** (biblioteca inteira, inclusive nunca jogados e jogos da **Steam Family**):

1. Perfil → Privacidade → **Detalhes dos jogos = Público**, **ou**
2. Uma chave em `steamWebApiKey` no `config.json`, gerada em https://steamcommunity.com/dev/apikey

Wishlist pública não basta. Sem um desses dois, o script junta o que achar neste Windows (`localconfig.vdf`, cache da biblioteca, grupo Família no cliente) — jogos nunca abertos aqui e a lista compartilhada da família podem faltar. O `conectar-steam.bat` **não** pede a chave da Web API; só o SteamID64.

Não coloque SteamID nem chave no `config.example.json` nem no repositório.

## Uso


Atualização manual (sempre busca preços):

```bash
npm run update
```

Ou dê um duplo clique em `atualizar.bat`.

Agendar todo dia (respeita “já rodei hoje”):

```bash
npm run install:scheduler
```

O Agendador chama `npm run update:daily`, que **não** baixa de novo se já atualizou na data de hoje (`America/Sao_Paulo`).

## O que o script faz

1. Lê a wishlist (`IWishlistService/GetWishlist`)
2. Detecta jogos **novos** e **removidos**
3. Para cada jogo, consulta `appdetails` (preço BRL, capa, tags) e avaliações
4. Acrescenta **um ponto por dia** em `Data/priceHistory.json` — o histórico **nunca é apagado**
5. Gera/atualiza uma nota em `Games/`
6. O dashboard Dataview lê essas notas

Jogos saídos da wishlist **não perdem histórico**; a nota fica com `on_wishlist: false` e some das tabelas principais.

## Backlog (zerar o que você comprou)

Nota `Backlog Steam.md`: a **biblioteca inteira** ainda não marcada, inclusive **nunca jogados** e jogos da **Steam Family** quando a Steam entrega essa lista. Marque a caixa e clique **Atualizar** para mandar o jogo para `Não vou jogar.md` (lista cinza). Desmarcar lá e Atualizar devolve ao Backlog. **Atualizar** só adiciona compras novas; nada some por horas jogadas.

O botão **Atualizar** da wishlist também reconstrói os dois painéis. `npm run panel` usa o cache `Data/ownedPlaytimes.json` se a rede falhar.

Ative os snippets **game-backlog-dashboard** e **game-backlog-skipped** em Ajustes → Aparência → Snippets CSS. Copie `Snippets/*.css` para `.obsidian/snippets/` se o visual não aparecer.

## Estrutura

```
config.json
package.json
Scripts/updateWishlist.js    ponto de entrada
Scripts/backlog.js
Scripts/steamApi.js
Scripts/historyManager.js
Scripts/stores.js
Scripts/notes.js
Scripts/config.js
Scripts/installScheduler.ps1
Data/wishlist.json
Data/priceHistory.json
Data/ownedPlaytimes.json
Data/backlogDone.json
Data/backlogTracked.json
Games/                       notas geradas
Dashboard/Steam Wishlist Dashboard.md
Dashboard/Backlog Steam.md
Backlog Steam.md
```

## Cores

- Verde: em promoção (preço abaixo do normal)
- Azul: preço cheio, igual ao valor gravado na primeira vez
- Vermelho: o preço cheio subiu em relação ao que foi salvo (ex.: era R$ 70 e passou a R$ 90)

O **menor preço** é o recorde **local**. A Steam não publica histórico; SteamDB não tem API pública. Quanto mais dias o script rodar, melhor essa coluna.

## Lojas (Nuuvem, GMG, Fanatical)

Cada nota tem links de busca nessas lojas. Preços ao vivo só aparecem se você colocar `itadApiKey` no `config.json` (API gratuita do IsThereAnyDeal). Sem a chave, os links continuam funcionando.

## Plugins

- Dataview (obrigatório, com JavaScript ligado)
- Templater (já no vault; não é necessário para o sync)
- Obsidian Charts (opcional, gráficos na ficha do jogo)

Nenhum plugin pago.

## Publicar no GitHub

Pode subir o código. **Não** dá para ninguém entrar na sua Steam com o que está neste projeto: não há senha, cookie, sessão nem token da Valve. O `conectar-steam.bat` só pede o SteamID64 pelo login oficial (OpenID) e grava o número no `config.json` da sua máquina.

Ainda assim **não publique dados pessoais**:

- `config.json` — SteamID, caminho do PC, chave opcional do IsThereAnyDeal e da Steam Web API
- `Data/` — wishlist, histórico de preços, jogos da biblioteca
- `Games/` e `Minha Wishlist Steam.md` — suas notas

O `.gitignore` já ignora isso. Use `config.example.json` como modelo. Copie o CSS `game-wishlist-dashboard.css` e `game-backlog-dashboard.css` para `.obsidian/snippets/` no vault.

O SteamID64 de um perfil **público** já aparece na URL da Steam; sozinho não abre a conta. Se a wishlist for pública, a lista de jogos também já é visível na Steam.

## Remover o agendamento

No PowerShell:

```powershell
Unregister-ScheduledTask -TaskName SteamWishlistDashboard -Confirm:$false
```
