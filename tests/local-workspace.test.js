import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { localWorkspace } from "../scripts/local-workspace.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE objects (key TEXT PRIMARY KEY, tag TEXT, data BLOB)");
  return db;
}
const oldSpace = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
function addSpace(db, ns) {
  const state = { drafts: [], materials: [], uploads: {} };
  db.prepare("INSERT INTO objects VALUES(?,?,?)").run("state/" + ns, "v1", Buffer.from(JSON.stringify(state)));
}

test("fresh local deployments retain a common workspace across restarts", () => {
  const db = database();
  assert.equal(localWorkspace(db, []), "local");
  assert.equal(localWorkspace(db, []), "local");
  db.close();
});

test("upgrading keeps historical spaces isolated until the operator selects one", () => {
  const db = database();
  addSpace(db, oldSpace);
  assert.equal(localWorkspace(db, []), "");
  addSpace(db, other);
  assert.throws(() => localWorkspace(db, ["--shared"]), /多个旧空间/);
  assert.throws(() => localWorkspace(db, ["--workspace", "wrong"]), /找不到/);
  assert.equal(localWorkspace(db, ["--workspace", oldSpace]), oldSpace);
  assert.equal(localWorkspace(db, []), oldSpace);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM objects").get().n, 2);
  db.close();
});

test("a single legacy editor workspace can be adopted without rewriting its data", () => {
  const db = database();
  addSpace(db, oldSpace);
  assert.equal(localWorkspace(db, ["--shared"]), oldSpace);
  assert.equal(localWorkspace(db, []), oldSpace);
  db.close();
});
