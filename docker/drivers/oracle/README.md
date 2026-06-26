# Oracle Drivers

Este diretório existe apenas como ponto de montagem local para drivers Oracle ODBC.

Não versione binários, bibliotecas, `tnsnames.ora`, `sqlnet.ora` ou qualquer outro arquivo proprietário aqui.

Fluxo recomendado:

1. Baixe localmente o Oracle Instant Client e o Oracle Instant Client ODBC a partir do portal oficial da Oracle.
2. Extraia os arquivos neste diretório ou aponte `MCP_ODBC_DRIVERS_SOURCE` para outro caminho local fora do repositório.
3. Ajuste seu `odbcinst.ini`, `odbc.ini` e, se necessário, `TNS_ADMIN` no host conforme sua instalação local.

Este repositório publica apenas a estrutura esperada, não os binários.
