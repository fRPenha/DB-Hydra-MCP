import assert from "node:assert/strict";
import test from "node:test";

import { formatRows } from "../src/output.ts";

const rows = [{ ID: 374510n, NOME: "LARYSSA   ", OBS: "a\tb\nc" }];

test("json serializa BigInt e remove padding de CHAR", () => {
  assert.deepEqual(JSON.parse(formatRows(rows, "json")), [{ ID: 374510, NOME: "LARYSSA", OBS: "a\tb\nc" }]);
});

test("BigInt fora do intervalo seguro vira string", () => {
  assert.equal(formatRows([{ ID: 2n ** 60n }], "jsonl"), '{"ID":"1152921504606846976"}');
});

test("tsv compacto com cabeçalho e sem quebras dentro da célula", () => {
  assert.equal(formatRows(rows, "tsv"), "ID\tNOME\tOBS\n374510\tLARYSSA\ta b c");
  assert.equal(formatRows([], "tsv"), "No results found.");
});
