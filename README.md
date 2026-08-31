# SteamControles

Controlador de valores da Steam: vê os preços da sua wishlist e dos jogos mais populares do momento no gg.deals e na Steam.

Dashboard local para o Obsidian: lê a **wishlist pública da Steam**, grava preços em **BRL** e monta um painel com promoções e histórico.

Você só adiciona ou remove jogos na Steam. O script detecta a mudança na próxima atualização.

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

A lista **precisa estar pública**. Sem isso a Steam devolve lista vazia.

## Conectar sua conta Steam

Não tem SteamID no repositório. Cada clone faz o login local:

1. Dê um duplo clique em `conectar-steam.bat`
2. O navegador abre o **Sign in through Steam** (oficial da Valve)
3. Você entra com sua conta (senha só na Steam; este projeto não vê)
4. O SteamID é gravado no **seu** `config.json`

A lista de desejos precisa estar **pública**: Perfil Steam → Privacidade → Lista de desejos. Sem isso a API da Valve não entrega os jogos, mesmo depois do login. Isso não deixa o perfil inteiro público.

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

## Estrutura

```
config.json
package.json
Scripts/updateWishlist.js    ponto de entrada
Scripts/steamApi.js
Scripts/historyManager.js
Scripts/stores.js
Scripts/notes.js
Scripts/config.js
Scripts/installScheduler.ps1
Data/wishlist.json
Data/priceHistory.json
Games/                       notas geradas
Dashboard/Steam Wishlist Dashboard.md
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

- `config.json` — SteamID, caminho do PC, chave opcional do IsThereAnyDeal
- `Data/` — wishlist, histórico de preços, jogos da biblioteca
- `Games/` e `Minha Wishlist Steam.md` — suas notas

O `.gitignore` já ignora isso. Use `config.example.json` como modelo. Copie o CSS `game-wishlist-dashboard.css` para `.obsidian/snippets/` no vault.

O SteamID64 de um perfil **público** já aparece na URL da Steam; sozinho não abre a conta. Se a wishlist for pública, a lista de jogos também já é visível na Steam.

## Remover o agendamento

No PowerShell:

```powershell
Unregister-ScheduledTask -TaskName SteamWishlistDashboard -Confirm:$false
```
