# DB Hydra MCP

Este repositório é uma adaptação local do projeto [OpenLinkSoftware/mcp-odbc-server](https://github.com/OpenLinkSoftware/mcp-odbc-server). O objetivo aqui não é substituir o upstream, e sim manter o projeto `DB-Hydra-MCP` como uma base operacional para uso pessoal e corporativo, com foco em consultas read-only a múltiplos bancos via MCP, segredos locais e operação em Linux com opção de containerização.

O repositório de trabalho para publicação e evolução é [fRPenha/DB-Hydra-MCP](https://github.com/fRPenha/DB-Hydra-MCP).

## Objetivo

- Expor vários bancos ODBC locais para clientes MCP por meio de perfis nomeados.
- Permitir que agentes escolham explicitamente um perfil sem receber credenciais.
- Manter credenciais, DSNs e arquivos ODBC fora do prompt e preferencialmente fora do diretório do projeto.
- Forçar consultas somente leitura em todos os perfis.

## Origem do Projeto

- Repositório de origem: `OpenLinkSoftware/mcp-odbc-server`
- Estratégia deste fork: adaptar documentação, configuração e operação para um cenário local multi-banco, mantendo atribuição clara ao upstream.

## Como o servidor funciona

Cada conexão é definida como um perfil local. O agente MCP enxerga apenas metadados seguros e precisa informar o `profile` em cada chamada. O servidor resolve a conexão internamente, executa apenas leitura e registra auditoria com hash e resumo da query, sem armazenar SQL bruto nem credenciais.

Tools principais:

- `list_profiles`
- `describe_profile`
- `get_schemas`
- `get_tables`
- `describe_table`
- `query_database`
- `query_database_md`
- `query_database_jsonl`

## Segurança

- O agente não deve receber `user`, `password` ou DSN como argumento de tool.
- `describe_profile` expõe apenas metadados seguros.
- Toda execução é tratada como `read-only`, mesmo que o perfil configure o contrário.
- Logs de auditoria guardam hash e resumo da query, nunca o texto completo.
- Para reduzir exposição, prefira usar um arquivo externo definido por `MCP_ODBC_ENV_FILE` em vez de um `.env` dentro do repositório.
- **O `.env` (ou o arquivo apontado por `MCP_ODBC_ENV_FILE`) é a única fonte de credenciais.** O servidor sempre conecta passando `UID=`/`PWD=` explícitos a partir dele, o que sobrepõe qualquer `UserID=`/`Password=` que exista no `odbc.ini` — por isso o `odbc.ini` deste repositório não guarda usuário/senha, só topologia (host, porta, database) e o driver. Trocar a senha de um perfil é sempre uma edição no `.env`, nunca no `odbc.ini`.
- Um perfil mal configurado (campo obrigatório ausente, número inválido) não derruba o servidor: ele é ignorado com aviso em log, e os demais perfis continuam disponíveis. O servidor só falha ao iniciar se **nenhum** perfil ficar válido.

## Pré-requisitos locais

- Node.js 21+
- `unixODBC` instalado no host quando a execução for fora de container
- Docker + Docker Compose, se for usar o fluxo containerizado (recomendado)
- DSNs válidos em `odbc.ini` (sem credenciais — veja Segurança) e, quando necessário, drivers registrados em `odbcinst.ini`
- Rede/VPN com rota até cada banco de dados. Isso é externo ao MCP: se um host não responde por ping/telnet, nenhuma configuração de perfil resolve o problema.

## Para agentes: instalar, configurar, usar e tratar erros

Esta seção é autossuficiente: um agente de desenvolvimento (ou uma pessoa) deve conseguir subir, configurar, registrar e operar este MCP seguindo só o que está aqui, sem precisar ler o resto do README. As demais seções existem como referência complementar (segurança, estrutura do repositório etc.).

### 0. Antes de começar: o que exige um humano

Duas coisas não podem ser resolvidas por um agente sozinho — pare e peça para a pessoa responsável:

1. **Credenciais reais de cada banco** (usuário/senha, host, porta, nome do banco/serviço). São segredos; um agente não deve inventá-los, adivinhá-los nem tentar extraí-los de logs/erros.
2. **Binário do Oracle Instant Client + Instant Client ODBC**, se algum perfil for Oracle. É proprietário, a Oracle não permite redistribuição, e este repositório não o inclui.

Além disso, se a conexão de um perfil falhar por timeout ou "host desconhecido", **investigue rede antes de tocar em configuração** (veja a seção de erros abaixo) — pode não ser um problema deste MCP.

### 1. Instalação

Escolha **um** dos dois caminhos. Não misture os dois ao mesmo tempo.

#### Opção A — Docker (recomendado, é o modo residente usado em produção)

```sh
npm install
cp docker/compose.env.example docker/.env.compose
```

Edite `docker/.env.compose` apontando para os arquivos reais de configuração (podem estar dentro ou fora do repositório):

```env
MCP_ODBC_ENV_SOURCE=./.env
MCP_ODBC_INI_SOURCE=./odbc.ini
MCP_ODBCINST_SOURCE=./odbcinst.ini
MCP_ODBC_DRIVERS_SOURCE=./docker/drivers
```

Depois de preencher `.env` e `odbc.ini` (seção 2 — Configuração):

```sh
mkdir -p docker/drivers
docker compose --env-file docker/.env.compose up -d --build
```

O container fica residente com `restart: unless-stopped`; cada sessão MCP entra nele sob demanda via `docker exec -i`, preservando o transporte `stdio`. Para reiniciar/aplicar mudanças de código ou de `odbcinst.ini`/drivers, repita o `up -d --build`. Mudanças em `.env` ou `odbc.ini` não exigem rebuild — eles são montados como bind mount e lidos a cada nova conexão; ainda assim, se algum cliente MCP mantiver o processo `node` já em execução, reinicie o container para garantir.

Se o Docker precisa sobreviver a reboot do host:

```sh
sudo systemctl enable docker
```

#### Opção B — Local (execução direta, sem container)

```sh
npm install
npm run build
```

Depois de preencher os arquivos de configuração (seção 2), inicie apontando as variáveis de ambiente do unixODBC para eles:

```sh
MCP_ODBC_ENV_FILE=$HOME/.config/mcp-odbc/profiles.env \
ODBCINI=$HOME/.config/mcp-odbc/odbc.ini \
ODBCSYSINI=$HOME/.config/mcp-odbc \
ODBCINSTINI=odbcinst.ini \
node dist/db-hydra-mcp.js
```

`profiles.env` é só um nome de exemplo — o arquivo pode se chamar qualquer coisa, o que importa é `MCP_ODBC_ENV_FILE` apontar para ele. O nome do arquivo versionado neste repositório (modelo, sem segredos) é `_env`.

### 2. Configuração

Existem três arquivos com responsabilidades diferentes. Nenhum deles se substitui:

| Arquivo | Responsabilidade | Tem credencial? |
|---|---|---|
| `.env` (ou o arquivo de `MCP_ODBC_ENV_FILE`) | Lista de perfis, engine, **usuário/senha**, limites | Sim — única fonte |
| `odbc.ini` | Topologia de cada DSN (host/porta/database) e qual driver usar | Não |
| `odbcinst.ini` | Registro dos drivers ODBC instalados (caminho do `.so`) | Não |

#### 2.1 Definir os perfis no `.env`

```env
MCP_ODBC_PROFILE_NAMES=oracle_erp_dev,postgres_portal_hml
MCP_ODBC_DEFAULT_PROFILE=postgres_portal_hml

MCP_ODBC_PROFILE_ORACLE_ERP_DEV_LABEL=ERP Oracle DEV
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_ENGINE=oracle
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_DSN=oracle_erp_dev
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_USER=usuario_local
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_PASSWORD=trocar-localmente
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_MAX_ROWS=200
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_TIMEOUT_MS=15000

MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_LABEL=Portal PostgreSQL HML
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_ENGINE=postgresql
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_DSN=postgres_portal_hml
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_USER=postgres
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_PASSWORD=trocar-localmente
```

Regra que costuma passar batido: **o valor de `..._DSN` precisa ser exatamente igual ao nome da seção `[...]` que você vai criar no `odbc.ini`** (passo 2.2). Não é um rótulo livre — é a chave que liga os dois arquivos. `..._READ_ONLY` é aceito mas ignorado: todo perfil é forçado a read-only pelo próprio servidor.

#### 2.2 Criar a seção correspondente no `odbc.ini`

O `Driver=` tem que bater exatamente com um nome já registrado em `odbcinst.ini` (`Oracle`, `PostgreSQL Unicode` ou `MariaDB Unicode` — MySQL usa o driver MariaDB, que é compatível). Nunca coloque `UserID=`/`Password=` aqui.

PostgreSQL:

```ini
[postgres_portal_hml]
Driver=PostgreSQL Unicode
Description=Portal PostgreSQL HML
Servername=10.10.48.122
Port=5432
Database=portal_agentes
SSLmode=prefer
```

MariaDB ou MySQL:

```ini
[kace]
Driver=MariaDB Unicode
Description=KACE MariaDB
SERVER=kacesma.exemplo.com.br
PORT=3306
DATABASE=ORG1
```

Oracle (exige um passo extra — veja 2.3):

```ini
[oracle_erp_dev]
Driver=Oracle
Description=ERP Oracle DEV
Port=1521
DBQ=oracle_erp_dev
ServerName=oracle_erp_dev
```

#### 2.3 Oracle: `tnsnames.ora` e `TNS_ADMIN`

Só para perfis Oracle. O driver ODBC da Oracle não resolve host/porta/serviço a partir do `odbc.ini` — `DBQ`/`ServerName` ali é um **alias** que precisa existir em um `tnsnames.ora`, apontado pela variável `TNS_ADMIN`.

`tnsnames.ora` (o alias precisa ser idêntico ao `DBQ`/`ServerName` usado no `odbc.ini`):

```
oracle_erp_dev =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = erpd0.exemplo.internal)(PORT = 1521))
    (CONNECT_DATA =
      (SERVICE_NAME = erpd0.exemplo.internal)
    )
  )
```

No fluxo Docker deste repositório, esse arquivo vive dentro do próprio Instant Client montado em `docker/drivers/oracle/<versao>/network/admin/tnsnames.ora`, e `TNS_ADMIN` já vem fixado em `compose.yaml` apontando para lá — só é preciso editar o `tnsnames.ora`, não a variável. No fluxo local (Opção B), defina `TNS_ADMIN` manualmente apontando para a pasta onde esse arquivo está antes de iniciar o processo.

Sem essa entrada, a conexão falha com `ORA-12154` (veja a tabela de erros).

#### 2.4 Registrar drivers em `odbcinst.ini`

Normalmente você não precisa tocar aqui — o repositório já traz o `odbcinst.ini` com os três drivers usados (`Oracle`, `PostgreSQL Unicode`, `MariaDB Unicode`) apontando para os caminhos instalados na imagem/host. Só edite se for adicionar um driver novo (engine ainda não suportado) ou mudar a versão do Oracle Instant Client — nesse caso, atualize o campo `Driver=` para o caminho do novo `.so`.

Dependência do Oracle: o operador precisa disponibilizar o Oracle Instant Client + Instant Client ODBC em `docker/drivers/oracle/` (não redistribuído por este repositório — ver seção 0). Sem esses arquivos o container sobe normalmente, mas qualquer perfil Oracle falha com erro de biblioteca ausente até o driver ser disponibilizado e a imagem reconstruída (`docker compose --env-file docker/.env.compose up -d --build`).

### 3. Registrar no cliente MCP

Exemplo de configuração para um cliente que já usa o container em execução (modelo mais adequado para `stdio`: o container fica residente, e cada sessão MCP cria um processo novo dentro dele):

```json
{
  "mcpServers": {
    "db-hydra-local": {
      "command": "docker",
      "args": ["exec", "-i", "db-hydra-mcp", "node", "/app/dist/db-hydra-mcp.js"]
    }
  }
}
```

Isso vai no arquivo de configuração de MCP do cliente específico (por exemplo `claude_desktop_config.json`, ou o `mcp.json` do seu editor) — o caminho varia por cliente.

Validação mínima depois de registrar:

1. Confirme que o servidor `db-hydra-local` aparece como disponível no cliente.
2. Execute `list_profiles` e confira se todos os perfis esperados aparecem.
3. Execute `describe_profile` em um perfil conhecido.
4. Execute `get_tables` ou `describe_table` antes da primeira query real.

### 4. Uso operacional

O agente trata o servidor como uma camada segura de consulta read-only e nunca tenta descobrir segredos por prompt, tool ou análise de erro.

Fluxo obrigatório:

1. Execute `list_profiles` para descobrir quais perfis existem.
2. Execute `describe_profile` para entender engine, limites e se o perfil é o padrão.
3. Antes de consultar dados de negócio, descubra a estrutura com `get_schemas`, `get_tables` e `describe_table`.
4. Só depois execute `query_database`, `query_database_md` ou `query_database_jsonl`.
5. Em consultas entre sistemas diferentes, faça uma etapa por perfil e carregue a chave de negócio de um banco para o outro.

Regras operacionais:

- Sempre informe `profile` explicitamente, mesmo quando houver perfil padrão.
- Nunca assuma nome de tabela, coluna ou schema sem inspecionar antes.
- Nunca solicite `user`, `password`, DSN completo ou conteúdo do `.env`.
- Considere que todos os perfis são `read-only` — uma tentativa de `insert`/`update`/`delete`/`drop`/etc. é rejeitada pelo servidor antes de chegar ao banco.
- Em caso de dúvida sobre um campo de negócio, use `describe_table` antes da query.

Exemplo de chamada:

```json
{
  "tool": "query_database",
  "arguments": {
    "profile": "postgres_portal_hml",
    "query": "select * from pnf fetch first 10 rows only",
    "format": "json"
  }
}
```

Exemplos de pedidos que um agente pode executar:

- `Liste os perfis disponíveis e descreva o profile oracle_erp_hml.`
- `No profile kace, descubra em qual tabela está o chamado 341655 e resuma status, responsável e histórico.`
- `No profile postgres_portal_hml, encontre a chave X e depois consulte o profile oracle_erp_hml para correlacionar o documento.`

Playbook para colar em outro agente:

```text
Use o servidor MCP "db-hydra-local" como camada de consulta read-only a bancos locais.

Regras:
- nunca peça credenciais;
- nunca tente ler .env, odbc.ini ou segredos do host;
- sempre descubra os perfis com list_profiles;
- sempre descreva o perfil com describe_profile antes de consultar;
- sempre inspecione schema/tabelas/colunas com get_schemas, get_tables e describe_table antes de assumir a estrutura;
- sempre informe o argumento profile explicitamente nas queries;
- faça correlações entre bancos em etapas, um profile por vez;
- responda com resumo objetivo dos dados encontrados e destaque limitações quando a estrutura não for suficiente.
```

### 5. Tratamento de erros

O erro chega no texto retornado pela tool (`Error: ...`) já sanitizado (sem credencial/DSN) e, em paralelo, uma linha de auditoria em JSON vai para stderr do processo com `success:false`, mas sem o texto do erro. Para investigar a causa raiz de um erro de conexão, normalmente é preciso olhar o log do container (`docker compose ... logs`) ou reproduzir com `isql` (ver seção Verificação rápida) — o agente não deve tentar contornar a sanitização para "ver a senha", só precisa identificar a causa.

| Mensagem/sintoma | Causa provável | O que fazer |
|---|---|---|
| `Unknown profile: X` | Nome de perfil errado ou não normalizado (nomes são case-insensitive, comparados em minúsculo) | Confira com `list_profiles` o nome exato |
| `An explicit profile is required for this server configuration` | Servidor está em modo multi-perfil e a tool foi chamada sem `profile` | Informe `profile` explicitamente |
| `Profile X is read-only and rejected a mutating statement` | Query contém `insert`/`update`/`delete`/`drop`/etc. | Esperado — reescreva como `select` |
| `Missing required setting ... for profile ...` (no log, na inicialização) | Falta `DSN`/`USER`/`PASSWORD` daquele perfil no `.env` | Corrija o `.env`; os demais perfis continuam funcionando normalmente |
| `No valid profiles configured` | Nenhum perfil do `.env` passou a validação | Revise o `.env` — sem isso o servidor não sobe |
| `... timed out after Xms` | Conexão ou query não respondeu dentro de `TIMEOUT_MS` do perfil | Normalmente é rede/host lento ou fora do ar, não um bug de config — teste conectividade (abaixo) antes de aumentar o timeout |
| `ORA-12154: TNS:could not resolve the connect identifier` | `DBQ`/`ServerName` do `odbc.ini` não tem entrada correspondente em `tnsnames.ora`, ou `TNS_ADMIN` não aponta para a pasta certa | Ver seção 2.3 |
| `ORA-01017: invalid username/password; logon denied` | Usuário/senha errados no `.env` para aquele perfil Oracle | Confirme a credencial com quem administra o banco |
| `[unixODBC] Unknown server host '...'` | O host do `odbc.ini` não resolve em DNS (nome errado, endpoint renomeado/desativado) | `getent hosts <host>` de dentro do container; se não resolver em lugar nenhum, é o endpoint que mudou, não a config do MCP |
| `fe_sendauth: no password supplied` (PostgreSQL) / `Access denied for user '...' (using password: NO)` (MariaDB/MySQL) | Testando com `isql` direto na DSN sem usuário/senha (o `odbc.ini` não tem mais credenciais, de propósito) | Normal ao testar com `isql <dsn>` puro; teste com `isql <dsn> <user> <senha>`, ou valide pelo próprio MCP (`query_database`), que sempre envia `UID=`/`PWD=` do `.env` |
| Conexão trava sem erro por vários segundos, depois falha | Host inalcançável na rede (firewall descartando pacote, VPN fora, endereço errado) | `ping`/`telnet host porta` a partir do host que roda o container; se falhar por lá também, é rede, não é este MCP |
| Perfil Oracle falha com erro de biblioteca/driver ausente | Instant Client não foi disponibilizado em `docker/drivers/oracle/` | Ver seção 2.4; depois de copiar os binários, reconstrua a imagem |

## Checklist de integração

Antes de registrar este servidor em outro agente, valide:

1. O container `db-hydra-mcp` está em execução (`docker compose ... ps`).
2. Os arquivos `.env`, `odbc.ini` e `odbcinst.ini` apontam para conexões válidas (e, para Oracle, o `tnsnames.ora` tem o alias certo).
3. Drivers adicionais necessários, como Oracle ODBC, estão disponíveis no host/container.
4. O cliente MCP está configurado para iniciar o servidor via `docker exec -i`.
5. A validação inicial com `list_profiles` funciona sem erro e lista os perfis esperados.

## Drivers e bancos

Suporte inicial pensado para:

- Oracle via driver ODBC externo
- PostgreSQL
- MariaDB
- MySQL compatível com ODBC

A imagem instala `unixODBC` e drivers livres para PostgreSQL e MariaDB. O perfil MySQL deste repositório usa o driver `MariaDB Unicode`, que normalmente funciona com servidores MySQL compatíveis. O único caso que continua exigindo binário externo adicional é o Oracle (seções 0 e 2.4).

## Verificação rápida

Local:

```sh
npm test
npm run build
```

Container:

```sh
docker compose --env-file docker/.env.compose ps
docker compose --env-file docker/.env.compose logs --tail=100 db-hydra-mcp
docker exec -i db-hydra-mcp node /app/dist/db-hydra-mcp.js
```

Testar uma DSN isoladamente (fora do MCP, útil para depurar erro de rede/driver sem envolver credenciais do `.env`):

```sh
docker exec db-hydra-mcp isql -v <nome_da_dsn> <usuario> <senha>
```

## Estrutura relevante do repositório

- `src/main.ts`: servidor MCP
- `src/config.ts`: perfis e resolução de configuração
- `src/security.ts`: política read-only e auditoria
- `src/env.ts`: carregamento de ambiente com suporte a arquivo externo
- `compose.yaml`: execução containerizada local
- `Dockerfile`: imagem base do runtime

## Observações

- `.env`, `odbc.ini` e `odbcinst.ini` reais não devem ser versionados.
- Esta base continua compatível com execução local direta em Linux.
- A containerização complementa o uso local; ela não substitui o modelo `stdio` do MCP.
