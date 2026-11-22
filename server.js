const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const webpush = require("web-push");

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
  CREATE TABLE IF NOT EXISTS tarefas(id SERIAL PRIMARY KEY, setor_id INT REFERENCES setores(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL, resp_id INT REFERENCES funcionarios(id) ON DELETE SET NULL, prazo TEXT,
    inicio BIGINT, fim BIGINT, criado BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS obs(id SERIAL PRIMARY KEY, tarefa_id INT NOT NULL REFERENCES tarefas(id) ON DELETE CASCADE,
    autor_id INT REFERENCES funcionarios(id) ON DELETE CASCADE, gestor BOOLEAN NOT NULL DEFAULT false,
    texto TEXT NOT NULL, em BIGINT NOT NULL, editado BIGINT);
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS telefone TEXT UNIQUE;
  CREATE TABLE IF NOT EXISTS anexos(id SERIAL PRIMARY KEY, tarefa_id INT NOT NULL REFERENCES tarefas(id) ON DELETE CASCADE,
    nome TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INT NOT NULL, dados BYTEA NOT NULL, em BIGINT NOT NULL);
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS ciente BIGINT;
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES tarefas(id) ON DELETE CASCADE;
  -- Versão 2: prioridade, detalhes e tarefa para uma pessoa ou para um grupo
  ALTER TABLE tarefas ALTER COLUMN setor_id DROP NOT NULL;
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS prioridade TEXT NOT NULL DEFAULT 'normal';
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS detalhes TEXT;
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS v2 BOOLEAN;
  ALTER TABLE anexos ADD COLUMN IF NOT EXISTS autor_id INT REFERENCES funcionarios(id) ON DELETE SET NULL;
  CREATE TABLE IF NOT EXISTS tarefa_pessoas(tarefa_id INT NOT NULL REFERENCES tarefas(id) ON DELETE CASCADE,
    func_id INT NOT NULL REFERENCES funcionarios(id) ON DELETE CASCADE,
    ciente BIGINT, inicio BIGINT, fim BIGINT, PRIMARY KEY(tarefa_id, func_id));
  CREATE INDEX IF NOT EXISTS tarefa_pessoas_func ON tarefa_pessoas(func_id);
  -- Versão 3: modelos, avisos no celular e foto de conclusão
  CREATE TABLE IF NOT EXISTS modelos(id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, detalhes TEXT, prioridade TEXT NOT NULL DEFAULT 'normal',
    pessoas INT[] NOT NULL DEFAULT '{}', criado BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS config(chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push(endpoint TEXT PRIMARY KEY, func_id INT REFERENCES funcionarios(id) ON DELETE CASCADE,
    gestor BOOLEAN NOT NULL DEFAULT false, dados TEXT NOT NULL, criado BIGINT NOT NULL);
  ALTER TABLE tarefa_pessoas ADD COLUMN IF NOT EXISTS avisado_prazo BIGINT;
  ALTER TABLE anexos ADD COLUMN IF NOT EXISTS conclusao BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS arquivada BIGINT;
  -- Segurança: turnos com foto do rosto e rondas de hora em hora
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS seguranca BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS turno TEXT;
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS turno_ini TEXT;
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS turno_fim TEXT;
  CREATE TABLE IF NOT EXISTS turnos(id SERIAL PRIMARY KEY, func_id INT NOT NULL REFERENCES funcionarios(id) ON DELETE CASCADE,
    inicio BIGINT NOT NULL, fim BIGINT, ronda_avisada INT NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS turnos_func ON turnos(func_id, inicio);
  CREATE TABLE IF NOT EXISTS seg_fotos(id SERIAL PRIMARY KEY, turno_id INT NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, rodada INT NOT NULL DEFAULT 0, local INT NOT NULL DEFAULT 0, mime TEXT NOT NULL, tamanho INT NOT NULL, dados BYTEA NOT NULL, em BIGINT NOT NULL);
  CREATE INDEX IF NOT EXISTS seg_fotos_turno ON seg_fotos(turno_id);
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS gestor BOOLEAN NOT NULL DEFAULT false;`);
  // Pedido do Bruce em 2026-11-22: Helena entra como gestora pelo celular (feito uma vez só)
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_helena'")).length) {
    await q(`INSERT INTO funcionarios(nome,telefone,token,criado,gestor) VALUES('Helena','11973667211',$1,$2,true)
      ON CONFLICT(telefone) DO UPDATE SET gestor=true, seguranca=false`, [crypto.randomBytes(12).toString("base64url"), Date.now()]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_helena','1') ON CONFLICT DO NOTHING");
  }
  // Leva as tarefas antigas (um responsável) para o novo formato, uma vez só
  await q(`
  INSERT INTO tarefa_pessoas(tarefa_id,func_id,ciente,inicio,fim)
    SELECT id,resp_id,ciente,inicio,fim FROM tarefas WHERE v2 IS NULL AND resp_id IS NOT NULL ON CONFLICT DO NOTHING;
  UPDATE tarefas SET v2=true WHERE v2 IS NULL;`);
  // Chaves dos avisos no celular: criadas uma vez e guardadas no banco
  let [k] = await q("SELECT valor FROM config WHERE chave='vapid'");
  if (!k) { const v = webpush.generateVAPIDKeys(); await q("INSERT INTO config(chave,valor) VALUES('vapid',$1) ON CONFLICT DO NOTHING", [JSON.stringify(v)]);
    [k] = await q("SELECT valor FROM config WHERE chave='vapid'"); }
  VAPID = JSON.parse(k.valor);
  webpush.setVapidDetails("mailto:avisos@natal-osasco.app", VAPID.publicKey, VAPID.privateKey);
}
let VAPID = null;
async function avisarCelular(onde, payload) {
  const subs = onde.gestor ? await q("SELECT * FROM push WHERE gestor=true")
    : onde.func.length ? await q("SELECT * FROM push WHERE func_id = ANY($1)", [onde.func]) : [];
  await Promise.all(subs.map(s => webpush.sendNotification(JSON.parse(s.dados), JSON.stringify(payload), { TTL: 6 * 3600 })
    .catch(e => { if (e.statusCode === 404 || e.statusCode === 410) return q("DELETE FROM push WHERE endpoint=$1", [s.endpoint]); console.error("push", e.statusCode || e.message); })));
}
const avisoSeguro = (onde, payload) => avisarCelular(onde, payload).catch(e => console.error("push", e.message));

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
    if (k) { const [f] = await q("SELECT id,nome,seguranca,gestor,turno,turno_ini,turno_fim FROM funcionarios WHERE token=$1", [k]);
      if (f && f.gestor) { req.eu = { tipo: "gestor", nome: f.nome, gid: f.id }; return next(); }
      if (f) { req.eu = { tipo: "func", id: f.id, nome: f.nome, seguranca: f.seguranca, turno: f.turno, turno_ini: f.turno_ini, turno_fim: f.turno_fim }; return next(); } }
    res.status(401).json({ erro: "Acesso expirado. Digite o seu celular para entrar de novo." });
  } catch (e) { next(e); }
});
const gestor = (req, res, next) => req.eu.tipo === "gestor" ? next() : res.status(403).json({ erro: "Só o gestor pode fazer isso." });
const txt = (v, max) => { const s = String(v ?? "").trim(); return s && s.length <= max ? s : null; };
const prazoOk = v => (v && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) ? v : null;
const PRIORIDADES = ["alta", "normal", "baixa"];
const w = fn => (req, res, next) => fn(req, res).catch(next);
const novoToken = () => crypto.randomBytes(12).toString("base64url");

app.get("/api/estado", w(async (req, res) => {
  if (req.eu.tipo === "gestor") {
    const [setores, tarefas, pessoas, obs, func, anexos] = await Promise.all([
      q("SELECT id,nome FROM setores"), q("SELECT * FROM tarefas ORDER BY id"), q("SELECT * FROM tarefa_pessoas"),
      q("SELECT * FROM obs ORDER BY em"), q("SELECT id,nome,telefone FROM funcionarios WHERE NOT seguranca AND NOT gestor ORDER BY nome"),
      q("SELECT id,tarefa_id,nome,tipo,tamanho,em,autor_id,conclusao FROM anexos ORDER BY id")]);
    const modelos = await q("SELECT * FROM modelos ORDER BY titulo");
    const gestores = await q("SELECT id,nome,telefone FROM funcionarios WHERE gestor ORDER BY nome");
    return res.json({ eu: req.eu, setores, tarefas, pessoas, obs, funcionarios: func, anexos, modelos, seg: await dadosSeg(), gestores });
  }
  if (req.eu.seguranca) return res.json({ eu: req.eu, seg: await dadosSeg(req.eu.id) });
  // Colaborador: só as tarefas em que ele está (e os colegas dessas tarefas)
  const ids = (await q("SELECT tp.tarefa_id FROM tarefa_pessoas tp JOIN tarefas t ON t.id=tp.tarefa_id WHERE tp.func_id=$1 AND t.arquivada IS NULL", [req.eu.id])).map(r => r.tarefa_id);
  const [setores, tarefas, pessoas, obs, func, anexos] = await Promise.all([
    q("SELECT id,nome FROM setores"), q("SELECT * FROM tarefas WHERE id = ANY($1) ORDER BY id", [ids]),
    q("SELECT * FROM tarefa_pessoas WHERE tarefa_id = ANY($1)", [ids]), q("SELECT * FROM obs WHERE tarefa_id = ANY($1) ORDER BY em", [ids]),
    q("SELECT id,nome FROM funcionarios ORDER BY nome"),
    q("SELECT id,tarefa_id,nome,tipo,tamanho,em,autor_id,conclusao FROM anexos WHERE tarefa_id = ANY($1) ORDER BY id", [ids])]);
  res.json({ eu: req.eu, setores, tarefas, pessoas, obs, funcionarios: func, anexos });
}));

// Segurança
const LOCAIS_PADRAO = ["Local 1", "Local 2", "Local 3"];
const HORA = 3600e3;
const horaOk = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? v : null;
async function locais() { const [r] = await q("SELECT valor FROM config WHERE chave='locais_seg'"); return r ? JSON.parse(r.valor) : LOCAIS_PADRAO; }
async function dadosSeg(soFunc) {
  const desde = Date.now() - 3 * 24 * HORA;
  const guardas = await q(`SELECT id,nome,telefone,turno,turno_ini,turno_fim FROM funcionarios WHERE seguranca ${soFunc ? "AND id=$1" : ""} ORDER BY nome`, soFunc ? [soFunc] : []);
  const ids = guardas.map(g => g.id);
  const turnos = await q("SELECT * FROM turnos WHERE func_id = ANY($1) AND (fim IS NULL OR inicio > $2) ORDER BY inicio DESC", [ids, soFunc ? Date.now() - 24 * HORA : desde]);
  const fotos = await q("SELECT id,turno_id,tipo,rodada,local,em FROM seg_fotos WHERE turno_id = ANY($1) ORDER BY em", [turnos.map(t => t.id)]);
  return { guardas, turnos, fotos, locais: await locais(), agora: Date.now() };
}
const turnoAberto = async fid => (await q("SELECT * FROM turnos WHERE func_id=$1 AND fim IS NULL ORDER BY inicio DESC LIMIT 1", [fid]))[0];
// Foto do segurança: entrada (rosto), ronda (local 1..3) ou saída (rosto)
app.post("/api/seg/foto", express.raw({ type: () => true, limit: "8mb" }), w(async (req, res) => {
  if (req.eu.tipo !== "func" || !req.eu.seguranca) return res.status(403).json({ erro: "Só os seguranças usam esta área." });
  const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!/^image\/(jpeg|png|webp)$/.test(mime) || !req.body || !req.body.length) return res.status(400).json({ erro: "Envie uma foto (JPG ou PNG)." });
  const tipo = req.get("x-tipo"), agora = Date.now();
  let t = await turnoAberto(req.eu.id);
  if (tipo === "entrada") {
    if (t) return res.status(400).json({ erro: "Seu turno já está aberto." });
    [t] = await q("INSERT INTO turnos(func_id,inicio) VALUES($1,$2) RETURNING *", [req.eu.id, agora]);
    await q("INSERT INTO seg_fotos(turno_id,tipo,mime,tamanho,dados,em) VALUES($1,'entrada',$2,$3,$4,$5)", [t.id, mime, req.body.length, req.body, agora]);
    avisoSeguro({ gestor: true }, { title: `🟢 ${req.eu.nome} chegou`, body: "Turno de segurança iniciado. Toque para ver a foto.", tag: "seg" + t.id });
    return res.json({ ok: 1 });
  }
  if (!t) return res.status(400).json({ erro: "Primeiro registre a chegada com a foto do rosto." });
  if (tipo === "ronda") {
    const rodada = Math.floor((agora - Number(t.inicio)) / HORA), local = Number(req.get("x-local"));
    if (rodada < 1) return res.status(400).json({ erro: "A primeira ronda é 1 hora depois da chegada." });
    if (![0, 1, 2].includes(local)) return res.status(400).json({ erro: "Local inválido." });
    await q("DELETE FROM seg_fotos WHERE turno_id=$1 AND tipo='ronda' AND rodada=$2 AND local=$3", [t.id, rodada, local]);
    await q("INSERT INTO seg_fotos(turno_id,tipo,rodada,local,mime,tamanho,dados,em) VALUES($1,'ronda',$2,$3,$4,$5,$6,$7)", [t.id, rodada, local, mime, req.body.length, req.body, agora]);
    return res.json({ ok: 1 });
  }
  if (tipo === "saida") {
    await q("INSERT INTO seg_fotos(turno_id,tipo,mime,tamanho,dados,em) VALUES($1,'saida',$2,$3,$4,$5)", [t.id, mime, req.body.length, req.body, agora]);
    await q("UPDATE turnos SET fim=$1 WHERE id=$2", [agora, t.id]);
    avisoSeguro({ gestor: true }, { title: `🔴 ${req.eu.nome} encerrou o turno`, body: "Toque para ver as fotos do turno.", tag: "seg" + t.id });
    return res.json({ ok: 1 });
  }
  res.status(400).json({ erro: "Tipo de foto inválido." });
}));
app.get("/api/seg/fotos/:id", w(async (req, res) => {
  const [f] = await q("SELECT f.mime,f.dados,t.func_id FROM seg_fotos f JOIN turnos t ON t.id=f.turno_id WHERE f.id=$1", [req.params.id]);
  if (!f) return res.status(404).send("Foto não encontrada");
  if (req.eu.tipo !== "gestor" && f.func_id !== req.eu.id) return res.status(403).send("Sem acesso");
  res.set("Content-Type", f.mime); res.set("Cache-Control", "private, max-age=86400"); res.send(f.dados);
}));
app.post("/api/seg/guardas", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  const turno = req.body.turno === "noite" ? "noite" : "dia", ini = horaOk(req.body.turno_ini), fim = horaOk(req.body.turno_fim);
  if (!ini || !fim) return res.status(400).json({ erro: "Informe o horário do turno (entrada e saída)." });
  const id = Number(req.body.id) || null;
  if ((await q("SELECT 1 FROM funcionarios WHERE telefone=$1 AND id IS DISTINCT FROM $2", [tel, id])).length) return res.status(400).json({ erro: "Esse celular já está cadastrado." });
  if ((await q("SELECT 1 FROM funcionarios WHERE lower(nome)=lower($1) AND id IS DISTINCT FROM $2", [nome, id])).length) return res.status(400).json({ erro: "Já existe alguém com esse nome." });
  if (id) await q("UPDATE funcionarios SET nome=$1,telefone=$2,turno=$3,turno_ini=$4,turno_fim=$5,token=CASE WHEN telefone IS DISTINCT FROM $2 THEN $7 ELSE token END WHERE id=$6 AND seguranca",
    [nome, tel, turno, ini, fim, id, novoToken()]);
  else await q("INSERT INTO funcionarios(nome,telefone,token,criado,seguranca,turno,turno_ini,turno_fim) VALUES($1,$2,$3,$4,true,$5,$6,$7)", [nome, tel, novoToken(), Date.now(), turno, ini, fim]);
  res.json({ ok: 1 });
}));
app.post("/api/seg/locais", gestor, w(async (req, res) => {
  const l = (Array.isArray(req.body.locais) ? req.body.locais : []).map((x, i) => txt(x, 40) || LOCAIS_PADRAO[i]).slice(0, 3);
  if (l.length !== 3) return res.status(400).json({ erro: "Informe os 3 locais." });
  await q("INSERT INTO config(chave,valor) VALUES('locais_seg',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify(l)]);
  res.json({ ok: 1 });
}));
app.post("/api/seg/turnos/:id/encerrar", gestor, w(async (req, res) => {
  await q("UPDATE turnos SET fim=$1 WHERE id=$2 AND fim IS NULL", [Date.now(), req.params.id]); res.json({ ok: 1 });
}));
// Alarme de hora em hora (aviso no celular do segurança)
async function verificarRondas() {
  const abertos = await q("SELECT t.*, f.nome FROM turnos t JOIN funcionarios f ON f.id=t.func_id WHERE t.fim IS NULL");
  for (const t of abertos) {
    const rodada = Math.floor((Date.now() - Number(t.inicio)) / HORA);
    if (rodada >= 1 && rodada > t.ronda_avisada && rodada <= 24) {
      await q("UPDATE turnos SET ronda_avisada=$1 WHERE id=$2", [rodada, t.id]);
      const nomes = (await locais()).join(", ");
      await avisarCelular({ func: [t.func_id] }, { title: "🔔 Hora da ronda!", body: `Abra o app e fotografe: ${nomes}.`, tag: "ronda" + t.id, alarme: true });
    }
  }
}

// Funcionários
app.post("/api/funcionarios", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  if ((await q("SELECT 1 FROM funcionarios WHERE lower(nome)=lower($1)", [nome])).length) return res.status(400).json({ erro: "Já existe alguém com esse nome." });
  if ((await q("SELECT 1 FROM funcionarios WHERE telefone=$1", [tel])).length) return res.status(400).json({ erro: "Esse celular já está cadastrado." });
  res.json((await q("INSERT INTO funcionarios(nome,telefone,token,criado,gestor) VALUES($1,$2,$3,$4,$5) RETURNING id", [nome, tel, novoToken(), Date.now(), !!req.body.gestor]))[0]);
}));
app.patch("/api/funcionarios/:id", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  if ((await q("SELECT 1 FROM funcionarios WHERE telefone=$1 AND id<>$2", [tel, req.params.id])).length) return res.status(400).json({ erro: "Esse celular já está cadastrado." });
  await q("UPDATE funcionarios SET nome=$1, telefone=$2, token=CASE WHEN telefone IS DISTINCT FROM $2 THEN $4 ELSE token END WHERE id=$3", [nome, tel, req.params.id, novoToken()]); res.json({ ok: 1 });
}));
app.delete("/api/funcionarios/:id", gestor, w(async (req, res) => {
  if (req.eu.gid && Number(req.params.id) === req.eu.gid) return res.status(400).json({ erro: "Você não pode remover o seu próprio acesso." });
  await q("DELETE FROM funcionarios WHERE id=$1", [req.params.id]); res.json({ ok: 1 });
}));

// Tarefas
async function dadosTarefa(b, res) {
  const titulo = txt(b.titulo, 200); if (!titulo) { res.status(400).json({ erro: "Escreva o título da tarefa." }); return null; }
  const prazo = prazoOk(b.prazo); if (!prazo) { res.status(400).json({ erro: "Escolha a data e a hora da entrega." }); return null; }
  const prioridade = PRIORIDADES.includes(b.prioridade) ? b.prioridade : null;
  if (!prioridade) { res.status(400).json({ erro: "Escolha a prioridade." }); return null; }
  const detalhes = String(b.detalhes ?? "").trim().slice(0, 1000) || null;
  const pedidas = [...new Set((Array.isArray(b.pessoas) ? b.pessoas : []).map(Number).filter(Number.isInteger))];
  const pessoas = pedidas.length ? (await q("SELECT id FROM funcionarios WHERE id = ANY($1)", [pedidas])).map(r => r.id) : [];
  if (!pessoas.length) { res.status(400).json({ erro: "Escolha pelo menos um colaborador." }); return null; }
  return { titulo, prazo, prioridade, detalhes, pessoas };
}
app.post("/api/tarefas", gestor, w(async (req, res) => {
  const d = await dadosTarefa(req.body, res); if (!d) return;
  const [t] = await q("INSERT INTO tarefas(descricao,detalhes,prazo,prioridade,criado,v2) VALUES($1,$2,$3,$4,$5,true) RETURNING id",
    [d.titulo, d.detalhes, d.prazo, d.prioridade, Date.now()]);
  await q("INSERT INTO tarefa_pessoas(tarefa_id,func_id) SELECT $1, unnest($2::int[])", [t.id, d.pessoas]);
  if (req.body.salvarModelo) await q("INSERT INTO modelos(titulo,detalhes,prioridade,pessoas,criado) VALUES($1,$2,$3,$4,$5)", [d.titulo, d.detalhes, d.prioridade, d.pessoas, Date.now()]);
  avisoSeguro({ func: d.pessoas }, { title: "Tarefa nova" + (d.prioridade === "alta" ? " · PRIORIDADE ALTA" : ""), body: `${d.titulo}\nEntrega: ${fmtPrazo(d.prazo)}`, tag: "t" + t.id });
  res.json({ id: t.id });
}));
app.patch("/api/tarefas/:id", gestor, w(async (req, res) => {
  const d = await dadosTarefa(req.body, res); if (!d) return;
  const r = await q("UPDATE tarefas SET descricao=$1,detalhes=$2,prazo=$3,prioridade=$4 WHERE id=$5 RETURNING id", [d.titulo, d.detalhes, d.prazo, d.prioridade, req.params.id]);
  if (!r.length) return res.status(404).json({ erro: "Tarefa não encontrada." });
  await q("DELETE FROM tarefa_pessoas WHERE tarefa_id=$1 AND NOT (func_id = ANY($2::int[]))", [req.params.id, d.pessoas]);
  await q("UPDATE tarefa_pessoas SET avisado_prazo=NULL WHERE tarefa_id=$1", [req.params.id]);
  const novos = await q("INSERT INTO tarefa_pessoas(tarefa_id,func_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING RETURNING func_id", [req.params.id, d.pessoas]);
  if (novos.length) avisoSeguro({ func: novos.map(r => r.func_id) }, { title: "Tarefa nova", body: `${d.titulo}\nEntrega: ${fmtPrazo(d.prazo)}`, tag: "t" + req.params.id });
  res.json({ ok: 1 });
}));
// Arquivar (tira do painel, fica no histórico) e mudar só o prazo
app.post("/api/tarefas/:id/arquivar", gestor, w(async (req, res) => {
  await q("UPDATE tarefas SET arquivada=$1 WHERE id=$2", [req.body.desfazer ? null : Date.now(), req.params.id]); res.json({ ok: 1 });
}));
app.post("/api/tarefas/arquivar-concluidas", gestor, w(async (req, res) => {
  const r = await q(`UPDATE tarefas t SET arquivada=$1 WHERE arquivada IS NULL AND EXISTS(SELECT 1 FROM tarefa_pessoas p WHERE p.tarefa_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM tarefa_pessoas p WHERE p.tarefa_id=t.id AND p.fim IS NULL) RETURNING id`, [Date.now()]);
  res.json({ ok: 1, total: r.length });
}));
app.post("/api/tarefas/:id/prazo", gestor, w(async (req, res) => {
  const prazo = prazoOk(req.body.prazo); if (!prazo) return res.status(400).json({ erro: "Escolha a nova data e hora." });
  const r = await q("UPDATE tarefas SET prazo=$1 WHERE id=$2 RETURNING descricao", [prazo, req.params.id]);
  if (!r.length) return res.status(404).json({ erro: "Tarefa não encontrada." });
  await q("UPDATE tarefa_pessoas SET avisado_prazo=NULL WHERE tarefa_id=$1", [req.params.id]);
  const pend = (await q("SELECT func_id FROM tarefa_pessoas WHERE tarefa_id=$1 AND fim IS NULL", [req.params.id])).map(x => x.func_id);
  avisoSeguro({ func: pend }, { title: "📅 Prazo alterado", body: `${r[0].descricao}\nNova entrega: ${fmtPrazo(prazo)}`, tag: "t" + req.params.id });
  res.json({ ok: 1 });
}));
app.delete("/api/tarefas/:id", gestor, w(async (req, res) => { await q("DELETE FROM tarefas WHERE id=$1", [req.params.id]); res.json({ ok: 1 }); }));

// Acesso: gestor vê todas; colaborador só as tarefas em que está
async function minhaTarefa(req, res) {
  const [t] = await q("SELECT * FROM tarefas WHERE id=$1", [req.params.id]);
  if (!t) { res.status(404).json({ erro: "Tarefa não encontrada." }); return null; }
  if (req.eu.tipo === "gestor") return t;
  const [p] = await q("SELECT * FROM tarefa_pessoas WHERE tarefa_id=$1 AND func_id=$2", [t.id, req.eu.id]);
  if (p) { t.eu = p; return t; }
  res.status(403).json({ erro: "Esta tarefa não está no seu nome." }); return null;
}
const soColaborador = (req, res) => { if (req.eu.tipo === "func") return true; res.status(403).json({ erro: "Só o colaborador da tarefa aperta este botão." }); return false; };
app.post("/api/tarefas/:id/ciente", w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t || !soColaborador(req, res)) return;
  await q("UPDATE tarefa_pessoas SET ciente=COALESCE(ciente,$1) WHERE tarefa_id=$2 AND func_id=$3", [Date.now(), t.id, req.eu.id]); res.json({ ok: 1 });
}));
app.post("/api/tarefas/:id/iniciar", w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t || !soColaborador(req, res)) return;
  const agora = Date.now();
  await q("UPDATE tarefa_pessoas SET ciente=COALESCE(ciente,$1), inicio=COALESCE(inicio,$1) WHERE tarefa_id=$2 AND func_id=$3", [agora, t.id, req.eu.id]); res.json({ ok: 1 });
}));
const terminar = w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t || !soColaborador(req, res)) return;
  if (!t.eu.inicio) return res.status(400).json({ erro: "Aperte \"Iniciar\" antes de terminar." });
  if (!(await q("SELECT 1 FROM anexos WHERE tarefa_id=$1 AND autor_id=$2 AND conclusao=true", [t.id, req.eu.id])).length)
    return res.status(400).json({ erro: "Tire a foto do trabalho pronto para terminar." });
  const r = await q("UPDATE tarefa_pessoas SET fim=COALESCE(fim,$1) WHERE tarefa_id=$2 AND func_id=$3 AND fim IS NULL RETURNING fim", [Date.now(), t.id, req.eu.id]);
  if (r.length) avisoSeguro({ gestor: true }, { title: `✔ ${req.eu.nome} terminou`, body: t.descricao, tag: "f" + t.id + "-" + req.eu.id });
  res.json({ ok: 1 });
});
app.post("/api/tarefas/:id/terminar", terminar);
app.post("/api/tarefas/:id/finalizar", terminar);
app.post("/api/tarefas/:id/zerar/:func", gestor, w(async (req, res) => {
  await q("UPDATE tarefa_pessoas SET inicio=NULL, fim=NULL WHERE tarefa_id=$1 AND func_id=$2", [req.params.id, req.params.func]); res.json({ ok: 1 });
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

// Anexos (fotos, PDF e documentos) guardados no banco
const TIPOS = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "application/pdf": 1,
  "application/msword": 1, "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 1,
  "application/vnd.ms-excel": 1, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 1, "text/plain": 1 };
app.post("/api/tarefas/:id/anexos", express.raw({ type: () => true, limit: "12mb" }), w(async (req, res) => {
  const t = await minhaTarefa(req, res); if (!t) return;
  let tipo = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (tipo === "image/jpg" || tipo === "image/pjpeg") tipo = "image/jpeg";
  if (!TIPOS[tipo]) return res.status(400).json({ erro: "Formato não aceito. Envie foto (JPG ou PNG), PDF, Word ou Excel. Foto HEIC do iPhone: tire print ou exporte como JPG." });
  if (!req.body || !req.body.length) return res.status(400).json({ erro: "Arquivo vazio." });
  const nome = (decodeURIComponent(req.get("x-nome") || "arquivo")).slice(0, 120);
  const [{ total }] = await q("SELECT COALESCE(SUM(tamanho),0)::bigint AS total FROM anexos");
  if (Number(total) + req.body.length > 800 * 1024 * 1024) return res.status(400).json({ erro: "Espaço de anexos cheio. Apague anexos antigos." });
  const conclusao = req.get("x-conclusao") === "1" && req.eu.tipo === "func" && tipo.startsWith("image/");
  if (req.get("x-conclusao") === "1" && !conclusao) return res.status(400).json({ erro: "A foto de conclusão precisa ser uma foto (JPG ou PNG)." });
  await q("INSERT INTO anexos(tarefa_id,nome,tipo,tamanho,dados,em,autor_id,conclusao) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [t.id, nome, tipo, req.body.length, req.body, Date.now(), req.eu.tipo === "func" ? req.eu.id : null, conclusao]);
  res.json({ ok: 1 });
}));
app.get("/api/anexos/:id", w(async (req, res) => {
  const [a] = await q("SELECT tarefa_id,nome,tipo,dados FROM anexos WHERE id=$1", [req.params.id]);
  if (!a) return res.status(404).send("Arquivo não encontrado");
  if (req.eu.tipo === "func" && !(await q("SELECT 1 FROM tarefa_pessoas WHERE tarefa_id=$1 AND func_id=$2", [a.tarefa_id, req.eu.id])).length)
    return res.status(403).send("Este arquivo é de uma tarefa que não está no seu nome.");
  res.set("Content-Type", a.tipo);
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
  res.set("Cache-Control", "private, max-age=86400");
  res.send(a.dados);
}));
app.delete("/api/anexos/:id", gestor, w(async (req, res) => { await q("DELETE FROM anexos WHERE id=$1", [req.params.id]); res.json({ ok: 1 }); }));

// Modelos de tarefa
app.delete("/api/modelos/:id", gestor, w(async (req, res) => { await q("DELETE FROM modelos WHERE id=$1", [req.params.id]); res.json({ ok: 1 }); }));

// Avisos no celular
app.get("/api/push/chave", (req, res) => res.json({ chave: VAPID.publicKey }));
app.post("/api/push/assinar", w(async (req, res) => {
  const s = req.body && req.body.endpoint && req.body.keys ? req.body : null;
  if (!s || !/^https:\/\//.test(s.endpoint)) return res.status(400).json({ erro: "Assinatura inválida." });
  const G = req.eu.tipo === "gestor";
  await q(`INSERT INTO push(endpoint,func_id,gestor,dados,criado) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(endpoint) DO UPDATE SET func_id=$2, gestor=$3, dados=$4`, [s.endpoint, G ? null : req.eu.id, G, JSON.stringify(s), Date.now()]);
  res.json({ ok: 1 });
}));
app.post("/api/push/teste", w(async (req, res) => {
  await avisarCelular(req.eu.tipo === "gestor" ? { gestor: true } : { func: [req.eu.id] }, { title: "Avisos ligados ✔", body: "Você vai receber as tarefas novas aqui no celular.", tag: "teste" });
  res.json({ ok: 1 });
}));

// Prazo chegando: avisa 1 hora antes quem ainda não terminou
const fmtPrazo = p => { if (!p) return "sem prazo"; const [dt, hr] = p.split("T"); const [y, m, d] = dt.split("-"); return `${d}/${m}` + (hr ? ` às ${hr}` : ""); };
const agoraSP = (ms = Date.now()) => new Date(ms).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16).replace(" ", "T");
async function verificarPrazos() {
  const agora = agoraSP(), daqui1h = agoraSP(Date.now() + 3600e3);
  const rows = await q(`SELECT tp.tarefa_id, tp.func_id, t.descricao, t.prazo FROM tarefa_pessoas tp JOIN tarefas t ON t.id=tp.tarefa_id
    WHERE tp.fim IS NULL AND tp.avisado_prazo IS NULL AND t.arquivada IS NULL AND t.prazo LIKE '%T%' AND t.prazo > $1 AND t.prazo <= $2`, [agora, daqui1h]);
  for (const r of rows) {
    await q("UPDATE tarefa_pessoas SET avisado_prazo=$1 WHERE tarefa_id=$2 AND func_id=$3", [Date.now(), r.tarefa_id, r.func_id]);
    await avisarCelular({ func: [r.func_id] }, { title: "⏰ Prazo em menos de 1 hora", body: `${r.descricao}\nEntrega: ${fmtPrazo(r.prazo)}. Não esqueça de apertar TERMINAR.`, tag: "p" + r.tarefa_id });
  }
}

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: "Erro no servidor. Tente de novo." }); });

migrar().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Natal Osasco no ar na porta " + port));
  setInterval(() => verificarPrazos().catch(e => console.error("prazos", e.message)), 5 * 60 * 1000);
  setInterval(() => verificarRondas().catch(e => console.error("rondas", e.message)), 60 * 1000);
  verificarPrazos().catch(e => console.error("prazos", e.message));
}).catch(e => { console.error(e); process.exit(1); });
