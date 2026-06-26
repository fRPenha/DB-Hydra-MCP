FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    libaio1 \
    make \
    python3 \
    unixodbc \
    unixodbc-dev \
    odbcinst \
    odbc-postgresql \
    odbc-mariadb \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
COPY src ./src
COPY _env ./_env
COPY docker ./docker

RUN npm ci \
  && chmod +x /app/docker/entrypoint.sh \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV MCP_ODBC_ENV_FILE=/run/secrets/mcp-odbc.env
ENV ODBCINI=/run/odbc/odbc.ini
ENV ODBCSYSINI=/run/odbc
ENV ODBCINSTINI=odbcinst.ini

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["sleep", "infinity"]
