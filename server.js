const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const SENHAS = String(process.env.GESTOR_SENHA || "").split(",").map(x => x.trim()).filter(Boolean);
if (!SENHAS.length) { console.error("Defina GESTOR_SENHA"); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
});
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

async function migrar() {
  await q(`
  CREATE TABLE IF NOT EXISTS funcionarios(id SERIAL PRIMARY KEY, nome TEXT NOT NULL, token TEXT UNIQUE NOT NULL, criado BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS setores(id SERIAL PRIMARY KEY, nome TEXT NOT NULL, criado BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS tarefas(id SERIAL PRIMARY KEY, setor_id INT NOT NULL REFERENCES setores(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL, resp_id INT REFERENCES funcionarios(id) ON DELETE SET NULL, prazo TEXT,
    inicio BIGINT, fim BIGINT, criado BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS obs(id SERIAL PRIMARY KEY, tarefa_id INT NOT NULL REFERENCES tarefas(id) ON DELETE CASCADE,
    autor_id INT REFERENCES funcionarios(id) ON DELETE CASCADE, gestor BOOLEAN NOT NULL DEFAULT false,
    texto TEXT NOT NULL, em BIGINT NOT NULL, editado BIGINT);
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS telefone TEXT UNIQUE;
  CREATE TABLE IF NOT EXISTS anexos(id SERIAL PRIMARY KEY, tarefa_id INT NOT NULL REFERENCES tarefas(id) ON DELETE CASCADE,
    nome TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INT NOT NULL, dados BYTEA NOT NULL, em BIGINT NOT NULL);
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES tarefas(id) ON DELETE CASCADE;`);
}

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

// Público: entrada do funcionário pelo celular
const fone = v => { let d = String(v || "").replace(/\D/g, ""); if (d.length > 11 && d.startsWith("55")) d = d.slice(2); return d.length === 10 || d.length === 11 ? d : null; };
app.post("/api/entrar", async (req, res, next) => {
  try {
    const t = fone(req.body.telefone);
    const [f] = t ? await q("SELECT token FROM funcionarios WHERE telefone=$1", [t]) : [];
    if (!f) return res.status(404).json({ erro: "Celular não cadastrado. Confira o número ou fale com o gestor." });
    res.json({ chave: f.token });
  } catch (e) { next(e); }
});
app.post("/api/gestor", (req, res) => {
  const ok = SENHAS.find(x => igual(req.body.senha || "", x));
  if (ok) return res.json({ chave: ok });
  res.status(401).json({ erro: "Senha incorreta." });
});

const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
app.use("/api", async (req, res, next) => {
  try {
    const k = req.get("x-chave") || (req.method === "GET" && typeof req.query.k === "string" ? req.query.k : "");
    if (k && SENHAS.some(x => igual(k, x))) { req.eu = { tipo: "gestor" }; return next(); }
    if (k) { const [f] = await q("SELECT id,nome FROM funcionarios WHERE token=$1", [k]);
      if (f) { req.eu = { tipo: "func", id: f.id, nome: f.nome }; return next(); } }
    res.status(401).json({ erro: "Acesso expirado. Toque no seu nome para entrar de novo." });
  } catch (e) { next(e); }
});
const gestor = (req, res, next) => req.eu.tipo === "gestor" ? next() : res.status(403).json({ erro: "Só o gestor pode fazer isso." });
const txt = (v, max) => { const s = String(v ?? "").trim(); return s && s.length <= max ? s : null; };
const prazoOk = v => (v && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) ? v : null;
const w = fn => (req, res, next) => fn(req, res).catch(next);
const novoToken = () => crypto.randomBytes(12).toString("base64url");

app.get("/api/estado", w(async (req, res) => {
  const G = req.eu.tipo === "gestor";
  const [setores, tarefas, obs, func] = await Promise.all([
    q("SELECT * FROM setores ORDER BY criado"), q("SELECT * FROM tarefas ORDER BY id"),
    q("SELECT * FROM obs ORDER BY em"), q("SELECT id,nome,telefone FROM funcionarios ORDER BY nome")]);
  const anexos = await q("SELECT id,tarefa_id,nome,tipo,tamanho,em FROM anexos ORDER BY id");
  res.json({ eu: req.eu, setores, tarefas, obs, funcionarios: func, anexos });
}));

// Funcionários
app.post("/api/funcionarios", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  if ((await q("SELECT 1 FROM funcionarios WHERE lower(nome)=lower($1)", [nome])).length) return res.status(400).json({ erro: "Já existe alguém com esse nome." });
  if ((await q("SELECT 1 FROM funcionarios WHERE telefone=$1", [tel])).length) return res.status(400).json({ erro: "Esse celular já está cadastrado." });
  res.json((await q("INSERT INTO funcionarios(nome,telefone,token,criado) VALUES($1,$2,$3,$4) RETURNING id", [nome, tel, novoToken(), Date.now()]))[0]);
}));
app.patch("/api/funcionarios/:id", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  if ((await q("SELECT 1 FROM funcionarios WHERE telefone=$1 AND id<>$2", [tel, req.params.id])).length) return res.status(400).json({ erro: "Esse celular já está cadastrado." });
  await q("UPDATE funcionarios SET nome=$1, telefone=$2, token=CASE WHEN telefone IS DISTINCT FROM $2 THEN $4 ELSE token END WHERE id=$3", [nome, tel, req.params.id, novoToken()]); res.json({ ok: 1 });
}));
app.post("/api/funcionarios/:id/novo-link", gestor, w(async (req, res) => {
  await q("UPDATE funcionarios SET token=$1 WHERE id=$2", [novoToken(), req.params.id]); res.json({ ok: 1 });
}));
app.delete("/api/funcionarios/:id", gestor, w(async (req, res) => {
  await q("DELETE FROM funcionarios WHERE id=$1", [req.params.id]); res.json({ ok: 1 });
}));

// Setores
app.post("/api/setores", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 80); if (!nome) return res.status(400).json({ erro: "Informe o nome do setor." });
  await q("INSERT INTO setores(nome,criado) VALUES($1,$2)", [nome, Date.now()]); res.json({ ok: 1 });
}));
app.patch("/api/setores/:id", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 80); if (!nome) return res.status(400).json({ erro: "Informe o nome do setor." });
  await q("UPDATE setores SET nome=$1 WHERE id=$2", [nome, req.params.id]); res.json({ ok: 1 });
}));
app.delete("/api/setores/:id", gestor, w(async (req, res) => { await q("DELETE FROM setores WHERE id=$1", [req.params.id]); res.json({ ok: 1 }); }));

// Tarefas
function dadosTarefa(b) {
  const descricao = txt(b.descricao, 500); if (!descricao) return null;
  return [descricao, b.resp_id ? Number(b.resp_id) : null, prazoOk(b.prazo)];
}
app.post("/api/tarefas", gestor, w(async (req, res) => {
  const d = dadosTarefa(req.body); if (!d) return res.status(400).json({ erro: "Descreva a tarefa." });
  let setor = Number(req.body.setor_id), pai = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (pai) { const [p] = await q("SELECT setor_id,parent_id FROM tarefas WHERE id=$1", [pai]);
    if (!p || p.parent_id) return res.status(400).json({ erro: "Tarefa principal não encontrada." }); setor = p.setor_id; }
  await q("INSERT INTO tarefas(setor_id,descricao,resp_id,prazo,criado,parent_id) VALUES($1,$2,$3,$4,$5,$6)", [setor, ...d, Date.now(), pai]); res.json({ ok: 1 });
}));
app.patch("/api/tarefas/:id", gestor, w(async (req, res) => {
  const d = dadosTarefa(req.body); if (!d) return res.status(400).json({ erro: "Descreva a tarefa." });
  await q("UPDATE tarefas SET descricao=$1,resp_id=$2,prazo=$3 WHERE id=$4", [...d, req.params.id]); res.json({ ok: 1 });
}));
app.delete("/api/tarefas/:id", gestor, w(async (req, res) => { await q("DELETE FROM tarefas WHERE id=$1", [req.params.id]); res.json({ ok: 1 }); }));

async function minhaTarefa(req, res) {
  const [t] = await q("SELECT * FROM tarefas WHERE id=$1", [req.params.id]);
  if (!t) { res.status(404).json({ erro: "Tarefa não encontrada." }); return null; }
  if (req.eu.tipo === "gestor" || t.resp_id === req.eu.id) return t;
  res.status(403).json({ erro: "Esta tarefa não está no seu nome." }); return null;
}
async function liberada(t, res) {
  if (!t.parent_id) return true;
  const [p] = await q("SELECT fim FROM tarefas WHERE id=$1", [t.parent_id]);
  if (!p || p.fim) return true;
  res.status(400).json({ erro: "Esta subtarefa só libera quando a tarefa principal for finalizada." }); return false;
}
app.post("/api/tarefas/:id/iniciar", w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t || !(await liberada(t, res))) return;
  await q("UPDATE tarefas SET inicio=COALESCE(inicio,$1) WHERE id=$2", [Date.now(), t.id]); res.json({ ok: 1 });
}));
app.post("/api/tarefas/:id/finalizar", w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t || !(await liberada(t, res))) return;
  const agora = Date.now();
  await q("UPDATE tarefas SET inicio=COALESCE(inicio,$1), fim=COALESCE(fim,$1) WHERE id=$2", [agora, t.id]); res.json({ ok: 1 });
}));
app.post("/api/tarefas/:id/zerar", gestor, w(async (req, res) => {
  await q("UPDATE tarefas SET inicio=NULL, fim=NULL WHERE id=$1", [req.params.id]); res.json({ ok: 1 });
}));

// Observações
app.post("/api/tarefas/:id/obs", w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t) return;
  const texto = txt(req.body.texto, 1000); if (!texto) return res.status(400).json({ erro: "Escreva a observação." });
  const G = req.eu.tipo === "gestor";
  await q("INSERT INTO obs(tarefa_id,autor_id,gestor,texto,em) VALUES($1,$2,$3,$4,$5)", [t.id, G ? null : req.eu.id, G, texto, Date.now()]);
  res.json({ ok: 1 });
}));
app.patch("/api/obs/:id", w(async (req, res) => {
  const texto = txt(req.body.texto, 1000); if (!texto) return res.status(400).json({ erro: "Escreva a observação." });
  if (req.eu.tipo !== "func") return res.status(403).json({ erro: "Observações do gestor não são alteradas." });
  const r = await q("UPDATE obs SET texto=$1, editado=$2 WHERE id=$3 AND autor_id=$4 AND gestor=false RETURNING id", [texto, Date.now(), req.params.id, req.eu.id]);
  if (!r.length) return res.status(403).json({ erro: "Você só pode corrigir as suas observações." });
  res.json({ ok: 1 });
}));
app.delete("/api/obs/:id", w(async (req, res) => {
  const r = req.eu.tipo === "gestor"
    ? await q("DELETE FROM obs WHERE id=$1 AND gestor=false RETURNING id", [req.params.id])
    : await q("DELETE FROM obs WHERE id=$1 AND autor_id=$2 AND gestor=false RETURNING id", [req.params.id, req.eu.id]);
  if (!r.length) return res.status(403).json({ erro: "Essa observação não pode ser apagada." });
  res.json({ ok: 1 });
}));

// Anexos (fotos JPG/PNG e PDF) guardados no banco
const TIPOS = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "application/pdf": 1 };
app.post("/api/tarefas/:id/anexos", gestor, express.raw({ type: () => true, limit: "12mb" }), w(async (req, res) => {
  let tipo = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (tipo === "image/jpg" || tipo === "image/pjpeg") tipo = "image/jpeg";
  if (!TIPOS[tipo]) return res.status(400).json({ erro: "Formato não aceito. Envie foto (JPG, JPEG ou PNG) ou PDF. Foto HEIC do iPhone: tire print ou exporte como JPG." });
  if (!req.body || !req.body.length) return res.status(400).json({ erro: "Arquivo vazio." });
  const nome = (decodeURIComponent(req.get("x-nome") || "arquivo")).slice(0, 120);
  const [t] = await q("SELECT id FROM tarefas WHERE id=$1", [req.params.id]);
  if (!t) return res.status(404).json({ erro: "Tarefa não encontrada." });
  const [{ total }] = await q("SELECT COALESCE(SUM(tamanho),0)::bigint AS total FROM anexos");
  if (Number(total) + req.body.length > 800 * 1024 * 1024) return res.status(400).json({ erro: "Espaço de anexos cheio. Apague anexos antigos." });
  await q("INSERT INTO anexos(tarefa_id,nome,tipo,tamanho,dados,em) VALUES($1,$2,$3,$4,$5,$6)", [t.id, nome, tipo, req.body.length, req.body, Date.now()]);
  res.json({ ok: 1 });
}));
app.get("/api/anexos/:id", w(async (req, res) => {
  const [a] = await q("SELECT nome,tipo,dados FROM anexos WHERE id=$1", [req.params.id]);
  if (!a) return res.status(404).send("Arquivo não encontrado");
  res.set("Content-Type", a.tipo);
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
  res.set("Cache-Control", "private, max-age=86400");
  res.send(a.dados);
}));
app.delete("/api/anexos/:id", gestor, w(async (req, res) => { await q("DELETE FROM anexos WHERE id=$1", [req.params.id]); res.json({ ok: 1 }); }));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: "Erro no servidor. Tente de novo." }); });

migrar().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Natal Osasco no ar na porta " + port));
}).catch(e => { console.error(e); process.exit(1); });
