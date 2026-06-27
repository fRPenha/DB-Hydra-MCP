import { z } from "zod";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

interface ToolServer {
  tool(
    name: string,
    description: string,
    params: Record<string, unknown>,
    handler: (args: Record<string, any>) => Promise<ToolResult> | ToolResult,
  ): void;
}

interface VirtuosoToolsDependencies {
  server: ToolServer;
  profileParam: Record<string, unknown>;
  formatParam: Record<string, unknown>;
  apiKey: string;
  executeRowsTool: (options: {
    toolName: string;
    profileName?: string;
    format?: string;
    auditQuery: string;
    operation: (connection: any, profile: any) => Promise<Array<Record<string, unknown>>>;
  }) => Promise<ToolResult>;
  executeQueryTool: (options: {
    toolName: string;
    profileName?: string;
    query: string;
    format?: string;
  }) => Promise<ToolResult>;
  executeScalarTool: (options: {
    toolName: string;
    profileName?: string;
    auditQuery: string;
    operation: (connection: any, profile: any) => Promise<string>;
  }) => Promise<ToolResult>;
  normalizeRows: (rows: unknown) => Array<Record<string, unknown>>;
  enforceReadOnlyPolicy: (profileName: string, query: string) => void;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>;
}

export function hasVirtuosoProfile(profiles: Array<{ engine?: string }>): boolean {
  return profiles.some((profile) => profile.engine?.trim().toLowerCase() === "virtuoso");
}

export function registerVirtuosoTools({
  server,
  profileParam,
  formatParam,
  apiKey,
  executeRowsTool,
  executeQueryTool,
  executeScalarTool,
  normalizeRows,
  enforceReadOnlyPolicy,
  withTimeout,
}: VirtuosoToolsDependencies): void {
  server.tool(
    "virt_get_schemas",
    "Retrieve and return a list of all schema names from the connected Virtuoso database.",
    { ...profileParam, ...formatParam },
    async ({ profile, format = "json" }) =>
      executeRowsTool({
        toolName: "virt_get_schemas",
        profileName: profile,
        format,
        auditQuery: "SELECT DISTINCT name_part(KEY_TABLE,0) AS CATALOG_NAME FROM DB.DBA.SYS_KEYS",
        operation: async (connection) => {
          const result = await connection.query(
            "SELECT DISTINCT name_part(KEY_TABLE,0) AS CATALOG_NAME FROM DB.DBA.SYS_KEYS where __any_grants(KEY_TABLE) and table_type (KEY_TABLE) = 'TABLE' and KEY_IS_MAIN = 1 and KEY_MIGRATE_TO is NULL",
          );
          return normalizeRows(result);
        },
      }),
  );

  server.tool(
    "spasql_query",
    "Execute a SPASQL query and return results.",
    {
      query: z.string(),
      max_rows: z.number().optional(),
      timeout: z.number().optional(),
      format: z.string().optional(),
      ...profileParam,
    },
    async ({ query, max_rows, timeout, format = "json", profile }) =>
      executeScalarTool({
        toolName: "spasql_query",
        profileName: profile,
        auditQuery: query,
        operation: async (connection, selectedProfile) => {
          enforceReadOnlyPolicy(selectedProfile.name, query);
          const effectiveMaxRows = Math.min(max_rows ?? selectedProfile.maxRows, selectedProfile.maxRows);
          const effectiveTimeout = Math.min(timeout ?? selectedProfile.timeoutMs, selectedProfile.timeoutMs);
          const data = await withTimeout(
            connection.query("select Demo.demo.execute_spasql_query(?,?,?,?) as result", [
              query,
              effectiveMaxRows,
              effectiveTimeout,
              format,
            ]),
            effectiveTimeout,
            "spasql_query",
          );

          return String(((data as Array<{ result: string }>)[0]).result);
        },
      }),
  );

  server.tool(
    "virtuoso_support_ai",
    "Use the Virtuoso AI support function with the server-local API key.",
    { prompt: z.string(), ...profileParam },
    async ({ prompt, profile }) =>
      executeScalarTool({
        toolName: "virtuoso_support_ai",
        profileName: profile,
        auditQuery: "procedure:DEMO.DBA.OAI_VIRTUOSO_SUPPORT_AI",
        operation: async (connection) => {
          const data = await connection.query(
            "select DEMO.DBA.OAI_VIRTUOSO_SUPPORT_AI(?,?) as result",
            [prompt, apiKey],
          );
          return String(((data as Array<{ result: string }>)[0]).result);
        },
      }),
  );

  server.tool(
    "sparql_list_entity_types",
    "Retrieve entity types in the RDF graph, optionally filtered by graph IRI.",
    { graph_iri: z.string().optional(), ...profileParam, ...formatParam },
    async ({ graph_iri, profile, format = "json" }) => {
      const filterGraph = typeof graph_iri === "string" && graph_iri.trim() !== ""
        ? `FILTER (?g = <${graph_iri}>)`
        : "";
      const query = `SELECT DISTINCT * FROM (
        SPARQL
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        SELECT ?o
        WHERE {
            GRAPH ?g {
                ?s a ?o .
                OPTIONAL {
                    ?s rdfs:label ?label .
                    FILTER (LANG(?label) = "en" || LANG(?label) = "")
                }
                OPTIONAL {
                    ?s rdfs:comment ?comment .
                    FILTER (LANG(?comment) = "en" || LANG(?comment) = "")
                }
                FILTER (isIRI(?o) && !isBlank(?o))
            }
            ${filterGraph}
        }
        LIMIT 100
    ) AS x`;

      return executeQueryTool({
        toolName: "sparql_list_entity_types",
        profileName: profile,
        query,
        format,
      });
    },
  );

  server.tool(
    "sparql_list_entity_types_detailed",
    "Retrieve detailed entity types in the RDF graph, optionally filtered by graph IRI.",
    { graph_iri: z.string().optional(), ...profileParam, ...formatParam },
    async ({ graph_iri, profile, format = "json" }) => {
      const filterGraph = typeof graph_iri === "string" && graph_iri.trim() !== ""
        ? `FILTER (?g = <${graph_iri}>)`
        : "";
      const query = `
        SELECT * FROM (
            SPARQL
            PREFIX owl: <http://www.w3.org/2002/07/owl#>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            SELECT ?o, (SAMPLE(?label) AS ?label), (SAMPLE(?comment) AS ?comment)
            WHERE {
                GRAPH ?g {
                    ?s a ?o .
                    OPTIONAL {?o rdfs:label ?label . FILTER (LANG(?label) = "en" || LANG(?label) = "")}
                    OPTIONAL {?o rdfs:comment ?comment . FILTER (LANG(?comment) = "en" || LANG(?comment) = "")}
                    FILTER (isIRI(?o) && !isBlank(?o))
                }
               ${filterGraph}
            }
            GROUP BY ?o
            ORDER BY ?o
            LIMIT 20
        ) AS results
    `;

      return executeQueryTool({
        toolName: "sparql_list_entity_types_detailed",
        profileName: profile,
        query,
        format,
      });
    },
  );

  server.tool(
    "sparql_list_entity_types_samples",
    "Retrieve sample entities for each RDF entity type, optionally filtered by graph IRI.",
    { graph_iri: z.string().optional(), ...profileParam, ...formatParam },
    async ({ graph_iri, profile, format = "json" }) => {
      const filterGraph = typeof graph_iri === "string" && graph_iri.trim() !== ""
        ? `FILTER (?g = <${graph_iri}>)`
        : "";
      const query = `
        SELECT * FROM (
            SPARQL
            PREFIX owl: <http://www.w3.org/2002/07/owl#>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            SELECT (SAMPLE(?s) AS ?sample), ?slabel, (COUNT(*) AS ?sampleCount), (?o AS ?entityType), ?olabel
            WHERE {
                GRAPH ?g {
                    ?s a ?o .
                    OPTIONAL {?s rdfs:label ?slabel . FILTER (LANG(?slabel) = "en" || LANG(?slabel) = "")}
                    FILTER (isIRI(?s) && !isBlank(?s))
                    OPTIONAL {?o rdfs:label ?olabel . FILTER (LANG(?olabel) = "en" || LANG(?olabel) = "")}
                    FILTER (isIRI(?o) && !isBlank(?o))
                }
                ${filterGraph}
            }
            GROUP BY ?slabel ?o ?olabel
            ORDER BY DESC(?sampleCount) ?o ?slabel ?olabel
            LIMIT 20
        ) AS results
    `;

      return executeQueryTool({
        toolName: "sparql_list_entity_types_samples",
        profileName: profile,
        query,
        format,
      });
    },
  );

  server.tool(
    "sparql_list_ontologies",
    "Retrieve ontologies in the RDF graph, optionally filtered by graph IRI.",
    { graph_iri: z.string().optional(), ...profileParam, ...formatParam },
    async ({ graph_iri, profile, format = "json" }) => {
      const filterGraph = typeof graph_iri === "string" && graph_iri.trim() !== ""
        ? `FILTER (?g = <${graph_iri}>)`
        : "";
      const query = `
    SELECT * FROM (
        SPARQL
        DEFINE input:storage ""
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        SELECT ?s, ?label, ?comment
        WHERE {
            GRAPH ?g {
                ?s a owl:Ontology .
                OPTIONAL {
                    ?s rdfs:label ?label .
                    FILTER (LANG(?label) = "en" || LANG(?label) = "")
                }
                OPTIONAL {
                    ?s rdfs:comment ?comment .
                    FILTER (LANG(?comment) = "en" || LANG(?comment) = "")
                }
                FILTER (isIRI(?s) && !isBlank(?s))
            }
            ${filterGraph}
        }
        LIMIT 100
    ) AS x
    `;

      return executeQueryTool({
        toolName: "sparql_list_ontologies",
        profileName: profile,
        query,
        format,
      });
    },
  );

  server.tool(
    "chat_prompt_complete",
    "Use the OPAL backend to complete a chat prompt with the server-local API key.",
    {
      model: z.string(),
      prompt: z.string(),
      assistant_config_id: z.string().optional(),
      function_names: z.string().optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      max_tokens: z.number().optional(),
      ...profileParam,
    },
    async ({
      model,
      prompt,
      assistant_config_id = null,
      function_names = null,
      temperature = 0.2,
      top_p = 0.5,
      max_tokens = null,
      profile,
    }) =>
      executeScalarTool({
        toolName: "chat_prompt_complete",
        profileName: profile,
        auditQuery: "procedure:OAI.DBA.chatPromptComplete",
        operation: async (connection) => {
          const data = await connection.query(
            "select OAI.DBA.chatPromptComplete(?,?,?,?,?,?,?,?) as result",
            [model, prompt, assistant_config_id as any, function_names as any, temperature, top_p, max_tokens as any, apiKey],
          );

          return String((data[0] as { result: string }).result);
        },
      }),
  );
}
