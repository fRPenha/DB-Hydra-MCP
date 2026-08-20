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
- Toda execução é tratada como `read-only`.
- Logs de auditoria guardam hash e resumo da query, nunca o texto completo.
- Para reduzir exposição, prefira usar um arquivo externo definido por `MCP_ODBC_ENV_FILE` em vez de um `.env` dentro do repositório.
- **O `.env` (ou o arquivo apontado por `MCP_ODBC_ENV_FILE`) é a única fonte de credenciais.** O servidor sempre conecta passando `UID=`/`PWD=` explícitos a partir dele, o que sobrepõe qualquer `UserID=`/`Password=` que exista no `odbc.ini` — por isso o `odbc.ini` deste repositório não guarda usuário/senha, só topologia (host, porta, database) e o driver. Trocar a senha de um perfil é sempre uma edição no `.env`, nunca no `odbc.ini`.

## Pré-requisitos locais

- Node.js 21+
- `unixODBC` instalado no host quando a execução for fora de container
- DSNs válidos em `odbc.ini` (sem credenciais — veja Segurança) e, quando necessário, drivers registrados em `odbcinst.ini`

## Configuração local

O arquivo `_env` é apenas um modelo seguro. O recomendado é manter o arquivo real fora do repositório, por exemplo:

```sh
~/.config/mcp-odbc/profiles.env
~/.config/mcp-odbc/odbc.ini
~/.config/mcp-odbc/odbcinst.ini
```

Exemplo de inicialização local:

```sh
npm install
npm run build
MCP_ODBC_ENV_FILE=$HOME/.config/mcp-odbc/profiles.env \
ODBCINI=$HOME/.config/mcp-odbc/odbc.ini \
ODBCSYSINI=$HOME/.config/mcp-odbc \
ODBCINSTINI=odbcinst.ini \
node dist/db-hydra-mcp.js
```

Formato esperado no arquivo de perfis:

```env
MCP_ODBC_PROFILE_NAMES=oracle_erp_dev,postgres_portal_hml
MCP_ODBC_DEFAULT_PROFILE=postgres_portal_hml

MCP_ODBC_PROFILE_ORACLE_ERP_DEV_LABEL=ERP Oracle DEV
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_ENGINE=oracle
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_DSN=oracle_erp_dev
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_USER=usuario_local
MCP_ODBC_PROFILE_ORACLE_ERP_DEV_PASSWORD=trocar-localmente

MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_LABEL=Portal PostgreSQL HML
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_ENGINE=postgresql
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_DSN=postgres_portal_hml
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_USER=postgres
MCP_ODBC_PROFILE_POSTGRES_PORTAL_HML_PASSWORD=trocar-localmente
```

## Uso com clientes MCP

Fluxo recomendado:

1. Chame `list_profiles`.
2. Inspecione um perfil com `describe_profile`.
3. Execute a consulta sempre com `profile` explícito.

Exemplo conceitual:

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

## Para agentes de desenvolvimento

Este MCP foi desenhado para que o agente consulte bancos locais por perfis nomeados, sem acesso a credenciais. O agente deve tratar o servidor como uma camada segura de consulta read-only e nunca tentar descobrir segredos por prompt, tool ou análise de erro.

Fluxo obrigatório para uso correto:

1. Execute `list_profiles` para descobrir quais perfis existem.
2. Execute `describe_profile` para entender engine, limites e se o perfil é o padrão.
3. Antes de consultar dados de negócio, descubra a estrutura com `get_schemas`, `get_tables` e `describe_table`.
4. Só depois execute `query_database`, `query_database_md` ou `query_database_jsonl`.
5. Em consultas entre sistemas diferentes, faça uma etapa por perfil e carregue a chave de negócio de um banco para o outro.

Regras operacionais para o agente:

- Sempre informe `profile` explicitamente, mesmo quando houver perfil padrão.
- Nunca assuma nome de tabela, coluna ou schema sem inspecionar antes.
- Nunca solicite `user`, `password`, DSN completo ou conteúdo do `.env`.
- Considere que todos os perfis são `read-only`.
- Em caso de dúvida sobre um campo de negócio, use `describe_table` antes da query.

Exemplos de pedidos que um agente pode executar:

- `Liste os perfis disponíveis e descreva o profile oracle_erp_hml.`
- `No profile kace, descubra em qual tabela está o chamado 341655 e resuma status, responsável e histórico.`
- `No profile postgres_portal_hml, encontre a chave X e depois consulte o profile oracle_erp_hml para correlacionar o documento.`

## Checklist de integração

Antes de registrar este servidor em outro agente, valide:

1. O container `db-hydra-mcp` está em execução.
2. Os arquivos `profiles.env`, `odbc.ini` e `odbcinst.ini` apontam para conexões válidas.
3. Drivers adicionais necessários, como Oracle ODBC, estão disponíveis no host/container.
4. O cliente MCP está configurado para iniciar o servidor via `docker exec -i`.
5. A validação inicial com `list_profiles` funciona sem erro.

## Playbook rápido para outro agente

Você pode reutilizar o texto abaixo como instrução operacional em outro agente de desenvolvimento:

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

## Containerização local

Esta implementação adiciona um fluxo operacional para Docker/Linux sem embutir segredos na imagem. O container fica residente com `restart: unless-stopped`, e o cliente MCP inicia o processo sob demanda com `docker exec -i`, preservando o transporte `stdio`.

### Estrutura recomendada fora do repositório

```sh
~/.config/mcp-odbc/
  profiles.env
  odbc.ini
  odbcinst.ini
  drivers/
```

`drivers/` é útil principalmente para Oracle ou outros drivers proprietários.

### Subindo o container

1. Copie `docker/compose.env.example` para `docker/.env.compose`.
2. Ajuste os caminhos locais dos arquivos ODBC e do diretório de drivers.
3. Execute:

```sh
docker compose --env-file docker/.env.compose up -d --build
```

O serviço sobe em modo residente e reinicia automaticamente após reboot, desde que o Docker esteja habilitado no host:

```sh
sudo systemctl enable docker
```

### Quickstart com arquivos locais do repositório

Se você já possui `.env`, `odbc.ini` e `odbcinst.ini` locais neste repositório, pode subir o container sem mover os arquivos:

```sh
cat > docker/.env.compose <<'EOF'
MCP_ODBC_ENV_SOURCE=./.env
MCP_ODBC_INI_SOURCE=./odbc.ini
MCP_ODBCINST_SOURCE=./odbcinst.ini
MCP_ODBC_DRIVERS_SOURCE=./docker/drivers
EOF

mkdir -p docker/drivers
docker compose --env-file docker/.env.compose up -d --build
```

Nesse modo, o container usa os arquivos locais já existentes e continua com `restart: unless-stopped`.

### Registrando no agente MCP

Exemplo de configuração do cliente para usar o container já em execução:

```json
{
  "mcpServers": {
    "db-hydra-local": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "db-hydra-mcp",
        "node",
        "/app/dist/db-hydra-mcp.js"
      ]
    }
  }
}
```

Esse modelo é o mais adequado para `stdio`: o container permanece pronto no host, e cada sessão MCP cria um processo novo dentro dele.

Exemplo mínimo de validação depois do registro:

1. Abra o cliente MCP e confirme que o servidor `db-hydra-local` aparece como disponível.
2. Execute `list_profiles`.
3. Execute `describe_profile` em um perfil conhecido, por exemplo `kace`.
4. Execute `get_tables` ou `describe_table` antes da primeira query real.

## Drivers e bancos

Suporte inicial pensado para:

- Oracle via driver ODBC externo
- PostgreSQL
- MariaDB
- MySQL compatível com ODBC

A imagem instala `unixODBC` e drivers livres para PostgreSQL e MariaDB. O perfil MySQL deste repositório usa o driver `MariaDB Unicode`, que normalmente funciona com servidores MySQL compatíveis.

O único caso que continua exigindo binário externo adicional é o Oracle.

### Dependência adicional para Oracle

Para perfis Oracle, o operador precisa baixar localmente o Oracle Instant Client e o Oracle Instant Client ODBC e disponibilizar esse conteúdo em um caminho montado como `docker/drivers/oracle/`.

O repositório não publica binários, bibliotecas nem arquivos Oracle proprietários. Ele apenas reserva a estrutura esperada e a configuração do container.

Se o driver Oracle não estiver presente, o container continua subindo normalmente, mas qualquer tentativa de usar perfis Oracle falhará com erro de biblioteca ausente.

Depois de disponibilizar os arquivos localmente, reaplique a imagem:

```sh
docker compose --env-file docker/.env.compose up -d --build
```

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
