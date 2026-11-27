// Keep existing browser sandboxes private until the operator selects a source.
export function localWorkspace(db, args) {
  db.exec("CREATE TABLE IF NOT EXISTS local_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const saved = db.prepare("SELECT value FROM local_settings WHERE name='workspace'").get()?.value;
  const flag = args.indexOf("--workspace");
  if (flag >= 0 && !args[flag + 1]) throw Error("--workspace 后请填写编辑空间的编号");
  if (saved && flag < 0 && !args.includes("--list-workspaces")) return saved;

  const keys = db.prepare("SELECT key FROM objects WHERE key LIKE 'state/%' ORDER BY key").all()
    .map(({key}) => key.slice(6)).filter((ns) => /^[0-9a-f-]{36}$/.test(ns) || ns === "local");
  function list() {
    for (const ns of keys) {
      const row = db.prepare("SELECT data FROM objects WHERE key=?").get("state/" + ns);
      const s = JSON.parse(Buffer.from(row.data).toString());
      const edited = s.materials.filter((m) => m.version > 1 || !m.files.every((f) => f.seed));
      const uploads = Object.values(s.uploads || {});
      const titles = [...s.drafts, ...edited].slice(0, 3).map((m) => m.title).join("、");
      const filenames = uploads.slice(-3).map((f) => f.name).join("、");
      console.log(ns, "待审核", s.drafts.filter((m) => m.state === "待审核").length,
        "草稿及退回", s.drafts.filter((m) => m.state !== "待审核").length, "自建或换版资料", edited.length,
        "上传附件", uploads.length, titles, filenames);
    }
  }
  if (args.includes("--list-workspaces")) {
    list();
    return null;
  }
  let ns;
  if (flag >= 0) {
    ns = args[flag + 1];
    if (!keys.includes(ns)) throw Error("找不到指定空间，可用 --list-workspaces 查看");
  } else if (!keys.length) ns = "local";
  else if (args.includes("--shared") && keys.length === 1) ns = keys[0];
  else if (args.includes("--shared")) {
    list();
    throw Error("发现多个旧空间。请用 npm start -- --workspace 空间编号 选择编辑使用的空间。");
  } else {
    console.log("当前保留旧版的浏览器隔离模式。共享原有资料请用 npm start -- --shared。");
    return "";
  }
  db.prepare("INSERT OR REPLACE INTO local_settings(name,value) VALUES('workspace',?)").run(ns);
  return ns;
}
