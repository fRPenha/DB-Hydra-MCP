#!/bin/sh
set -eu

if [ -z "${MCP_ODBC_ENV_FILE:-}" ] || [ ! -f "${MCP_ODBC_ENV_FILE}" ]; then
  echo "Arquivo de perfis nao encontrado em MCP_ODBC_ENV_FILE=${MCP_ODBC_ENV_FILE:-}" >&2
  exit 1
fi

if [ -z "${ODBCINI:-}" ] || [ ! -f "${ODBCINI}" ]; then
  echo "Arquivo odbc.ini nao encontrado em ODBCINI=${ODBCINI:-}" >&2
  exit 1
fi

if [ -z "${ODBCSYSINI:-}" ] || [ ! -f "${ODBCSYSINI}/${ODBCINSTINI:-odbcinst.ini}" ]; then
  echo "Arquivo odbcinst.ini nao encontrado em ${ODBCSYSINI:-}/${ODBCINSTINI:-odbcinst.ini}" >&2
  exit 1
fi

node --input-type=module -e "await import('odbc')"
odbcinst -j >/dev/null

exec "$@"
