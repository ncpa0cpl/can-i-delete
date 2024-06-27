#!/usr/bin/env bun

/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import path from "node:path";

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(`Usage: can-i-delete <db-file> <target-table>`);
  process.exit(0);
}

const allTables = new Map<string, Table>();
const checkedTables = new Set<Table>();

const args = Bun.argv.slice(2);
const dbFilePath = args.at(-2)!;
const targetTable = args.at(-1)!;

if (args.length < 2) {
  console.error("can-i-delete <db-file> <target-table>");
  process.exit(1);
}

if (!(await Bun.file(dbFilePath).exists())) {
  console.error(`Database file not found: ${dbFilePath}`);
  process.exit(1);
}

const dbFile = path.resolve(dbFilePath);
const db = new Database(dbFile);

await db.query("PRAGMA foreign_keys = ON").run();

type RelationRecord = {
  name: string;
  table: string;
  from: string;
  to: string;
  on_delete: "NO ACTION" | "CASCADE";
};

// check if the table exists
const tableExists = await db
  .query<{ count: number }, [string]>(
    /* sql */ `
  SELECT COUNT(*) as count
  FROM sqlite_master
  WHERE type='table' AND name = ?;
`
  )
  .get(targetTable);

if (!tableExists || tableExists.count === 0) {
  console.error(`Table not found: ${targetTable}`);
  process.exit(1);
}

const relations = await db
  .query<RelationRecord, []>(
    /* sql */ `
  SELECT 
      m.name
      , p.*
  FROM
      sqlite_master m
      JOIN pragma_foreign_key_list(m.name) p ON m.name != p."table"
  WHERE m.type = 'table'
  ORDER BY m.name;
`
  )
  .all();

type TableRelation = {
  parent: Table;
  owner: "parent" | "self";
  table: Table;
  cascades: boolean;
};

type Table = {
  name: string;
  relations: Array<TableRelation>;
  collected: boolean;
};

const table: Table = {
  name: targetTable,
  relations: [],
  collected: false,
};

collectRelations(table);

const result = findNonCascading(table);

if (result) {
  const { found, relationChain } = result;
  console.log(
    `Found a NON-CASCADING relation between tables: '${found.parent.name}' <-> '${found.table.name}'`
  );
  console.log(
    "This relation can cause 'FOREIGN KEY constraint failed' error when deleting."
  );
  console.log("Full relation chain:");

  let indent = "";
  for (const line of relationChain) {
    console.log(indent + line);
    if (indent.length === 0) {
      indent = "└ ";
    }
    indent = "  " + indent;
  }
  process.exit(1);
} else {
  console.log("All relations cascade. Entries can be safely deleted.");
  process.exit(0);
}

function findNonCascading(
  table: Table
): { found: TableRelation; relationChain: string[] } | null {
  if (checkedTables.has(table)) return null;
  checkedTables.add(table);

  for (const relation of table.relations) {
    if (relation.owner === "parent") continue;

    if (!relation.cascades) {
      return {
        found: relation,
        relationChain: [relation.parent.name, relation.table.name],
      };
    }

    const result = findNonCascading(relation.table);

    if (result) {
      result.relationChain.unshift(relation.parent.name);
      return result;
    }
  }

  return null;
}

function collectRelations(table: Table) {
  if (table.collected) return;
  table.collected = true;

  for (const dbRelation of relations) {
    if (dbRelation.name === table.name) {
      const relatedTable = tableFor(dbRelation.table);

      table.relations.push({
        parent: table,
        owner: "parent",
        table: relatedTable,
        cascades: dbRelation.on_delete === "CASCADE",
      });

      collectRelations(relatedTable);
    } else if (dbRelation.table === table.name) {
      const relatedTable = tableFor(dbRelation.name);

      table.relations.push({
        parent: table,
        owner: "self",
        table: relatedTable,
        cascades: dbRelation.on_delete === "CASCADE",
      });

      collectRelations(relatedTable);
    }
  }

  for (const r of table.relations) {
    collectRelations(r.table);
  }
}

function tableFor(tableName: string): Table {
  const existing = allTables.get(tableName);
  if (existing) return existing;

  const table = {
    name: tableName,
    relations: [],
    collected: false,
  };
  allTables.set(tableName, table);
  return table;
}
