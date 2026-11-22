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
  ALTER TABLE seg_fotos ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE seg_fotos ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  ALTER TABLE seg_fotos ADD COLUMN IF NOT EXISTS precisao INT;
  ALTER TABLE seg_fotos ADD COLUMN IF NOT EXISTS suspeita TEXT;
  ALTER TABLE turnos ADD COLUMN IF NOT EXISTS pos_lat DOUBLE PRECISION;
  ALTER TABLE turnos ADD COLUMN IF NOT EXISTS pos_lng DOUBLE PRECISION;
  ALTER TABLE turnos ADD COLUMN IF NOT EXISTS pos_prec INT;
  ALTER TABLE turnos ADD COLUMN IF NOT EXISTS pos_em BIGINT;
  ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fora BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE turnos ADD COLUMN IF NOT EXISTS encerrado_por TEXT;
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS gestor BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS locais TEXT;
  ALTER TABLE seg_fotos ADD COLUMN IF NOT EXISTS local_nome TEXT;
  -- Botão de pânico
  ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS panico BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS panicos(id SERIAL PRIMARY KEY, func_id INT NOT NULL REFERENCES funcionarios(id) ON DELETE CASCADE,
    em BIGINT NOT NULL, lat DOUBLE PRECISION, lng DOUBLE PRECISION, precisao INT, atendido_por TEXT, atendido_em BIGINT);`);
  // Pedido do Bruce em 2026-11-22: Helena entra como gestora pelo celular (feito uma vez só)
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_helena'")).length) {
    await q(`INSERT INTO funcionarios(nome,telefone,token,criado,gestor) VALUES('Helena','11973667211',$1,$2,true)
      ON CONFLICT(telefone) DO UPDATE SET gestor=true, seguranca=false`, [crypto.randomBytes(12).toString("base64url"), Date.now()]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_helena','1') ON CONFLICT DO NOTHING");
  }
  // Bruce também entra como gestor só digitando o celular (a senha continua valendo)
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_bruce'")).length) {
    await q(`INSERT INTO funcionarios(nome,telefone,token,criado,gestor) VALUES('Bruce','44999417211',$1,$2,true)
      ON CONFLICT(telefone) DO UPDATE SET gestor=true, seguranca=false`, [crypto.randomBytes(12).toString("base64url"), Date.now()]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_bruce','1') ON CONFLICT DO NOTHING");
  }
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_patricia'")).length) {
    await q(`INSERT INTO funcionarios(nome,telefone,token,criado,gestor) VALUES('Patricia','44998738701',$1,$2,true)
      ON CONFLICT(telefone) DO UPDATE SET gestor=true, seguranca=false`, [crypto.randomBytes(12).toString("base64url"), Date.now()]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_patricia','1') ON CONFLICT DO NOTHING");
  }
  // Ponto zero da praça passado pelo Bruce em 2026-11-22 (raio padrão 300 m; o gestor pode mudar na aba Segurança)
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_base_praca'")).length) {
    await q("INSERT INTO config(chave,valor) VALUES('base_seg',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify({ lat: -23.49623, lng: -46.76902, raio: 300 })]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_base_praca','1') ON CONFLICT DO NOTHING");
  }
  // Pedido do Bruce em 2026-11-22: Alex recebe o alarme de pânico dos seguranças (feito uma vez só)
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_alex'")).length) {
    await q(`INSERT INTO funcionarios(nome,telefone,token,criado,panico) VALUES('Alex','11987997850',$1,$2,true)
      ON CONFLICT(telefone) DO UPDATE SET panico=true`, [crypto.randomBytes(12).toString("base64url"), Date.now()]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_alex','1') ON CONFLICT DO NOTHING");
  }
  // Alex tinha sido cadastrado como segurança: ele é colaborador comum (tarefas + visão da segurança + alarme do pânico)
  if (!(await q("SELECT 1 FROM config WHERE chave='seed_alex2'")).length) {
    await q("UPDATE funcionarios SET seguranca=false, gestor=false, panico=true WHERE telefone='11987997850'");
    await q("UPDATE turnos SET fim=COALESCE(fim,$1) WHERE fim IS NULL AND func_id=(SELECT id FROM funcionarios WHERE telefone='11987997850')", [Date.now()]);
    await q("INSERT INTO config(chave,valor) VALUES('seed_alex2','1') ON CONFLICT DO NOTHING");
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
  return subs.length;
}
const avisoSeguro = (onde, payload) => avisarCelular(onde, payload).catch(e => console.error("push", e.message));

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

// Usado pelo "despertador" do GitHub para o servidor grátis não dormir
app.get("/ping", (req, res) => res.type("text").send("ok"));
// Versão do app: o celular confere e recarrega sozinho quando sai versão nova
const VERSAO = process.env.RENDER_GIT_COMMIT || String(Date.now());
app.get("/versao", (req, res) => res.set("Cache-Control", "no-store").json({ v: VERSAO }));

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
    if (k) { const [f] = await q("SELECT id,nome,seguranca,gestor,panico,turno,turno_ini,turno_fim,locais FROM funcionarios WHERE token=$1", [k]);
      if (f && f.gestor) { req.eu = { tipo: "gestor", nome: f.nome, gid: f.id }; return next(); }
      if (f) { req.eu = { tipo: "func", id: f.id, nome: f.nome, seguranca: f.seguranca, turno: f.turno, turno_ini: f.turno_ini, turno_fim: f.turno_fim, locais: f.locais, panico: f.panico }; return next(); } }
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
    const centrais = await q("SELECT id,nome,telefone FROM funcionarios WHERE panico AND NOT gestor AND NOT seguranca ORDER BY nome");
    return res.json({ eu: req.eu, setores, tarefas, pessoas, obs, funcionarios: func, anexos, modelos, seg: await dadosSeg(), gestores, centrais, panicos: await listaPanicos(),
      testes: await testesAlarme(), zap: (await zapLista()).map(z => ({ nome: z.nome, telefone: z.telefone })) });
  }
  if (req.eu.seguranca) return res.json({ eu: req.eu, seg: await dadosSeg(req.eu.id), panicos: await listaPanicos(req.eu.id),
    centrais: await q("SELECT nome,telefone FROM funcionarios WHERE panico AND NOT seguranca ORDER BY nome") });
  // Colaborador: só as tarefas em que ele está (e os colegas dessas tarefas)
  const ids = (await q("SELECT tp.tarefa_id FROM tarefa_pessoas tp JOIN tarefas t ON t.id=tp.tarefa_id WHERE tp.func_id=$1 AND t.arquivada IS NULL", [req.eu.id])).map(r => r.tarefa_id);
  const [setores, tarefas, pessoas, obs, func, anexos] = await Promise.all([
    q("SELECT id,nome FROM setores"), q("SELECT * FROM tarefas WHERE id = ANY($1) ORDER BY id", [ids]),
    q("SELECT * FROM tarefa_pessoas WHERE tarefa_id = ANY($1)", [ids]), q("SELECT * FROM obs WHERE tarefa_id = ANY($1) ORDER BY em", [ids]),
    q("SELECT id,nome FROM funcionarios ORDER BY nome"),
    q("SELECT id,tarefa_id,nome,tipo,tamanho,em,autor_id,conclusao FROM anexos WHERE tarefa_id = ANY($1) ORDER BY id", [ids])]);
  const extra = req.eu.panico ? { panicos: await listaPanicos(), seg: await dadosSeg(), teste: (await testesAlarme()).find(t => t.para === req.eu.id && !t.ok) || null } : {};
  res.json({ eu: req.eu, setores, tarefas, pessoas, obs, funcionarios: func, anexos, ...extra });
}));

// Segurança
const LOCAIS_PADRAO = ["Local 1", "Local 2", "Local 3"];
const HORA = 3600e3;
const horaOk = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? v : null;
// Cada segurança tem a sua lista de locais; a cada ronda o app pega 3 seguidos, alternando pela lista
const listaLocais = (txt, padrao) => { try { const l = JSON.parse(txt || "null"); if (Array.isArray(l) && l.length >= 3) return l; } catch (e) {} return padrao; };
const locaisDaRonda = (lista, r) => [0, 1, 2].map(i => lista[((Math.max(r, 1) - 1) * 3 + i) % lista.length]);
async function locais() { const [r] = await q("SELECT valor FROM config WHERE chave='locais_seg'"); return r ? JSON.parse(r.valor) : LOCAIS_PADRAO; }
async function dadosSeg(soFunc) {
  const desde = Date.now() - 3 * 24 * HORA;
  const guardas = await q(`SELECT id,nome,telefone,turno,turno_ini,turno_fim,locais FROM funcionarios WHERE seguranca ${soFunc ? "AND id=$1" : ""} ORDER BY nome`, soFunc ? [soFunc] : []);
  const ids = guardas.map(g => g.id);
  const turnos = await q("SELECT * FROM turnos WHERE func_id = ANY($1) AND (fim IS NULL OR inicio > $2) ORDER BY inicio DESC", [ids, soFunc ? Date.now() - 24 * HORA : desde]);
  const padrao = await locais();
  guardas.forEach(g => { g.locais = listaLocais(g.locais, padrao); });
  const fotos = await q("SELECT id,turno_id,tipo,rodada,local,local_nome,em,lat,lng,precisao,suspeita FROM seg_fotos WHERE turno_id = ANY($1) ORDER BY em", [turnos.map(t => t.id)]);
  return { guardas, turnos, fotos, locais: await locais(), base: await baseSeg(), agora: Date.now() };
}
// Local de trabalho dos seguranças (ponto + raio em metros), definido pelo gestor
async function baseSeg() { const [r] = await q("SELECT valor FROM config WHERE chave='base_seg'"); return r ? JSON.parse(r.valor) : null; }
function distM(a, b) { const R = 6371e3, k = Math.PI / 180, dLat = (b.lat - a.lat) * k, dLng = (b.lng - a.lng) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : Math.round(m) + " m";
app.post("/api/seg/base", gestor, w(async (req, res) => {
  if (req.body.remover) { await q("DELETE FROM config WHERE chave='base_seg'"); return res.json({ ok: 1 }); }
  const lat = Number(req.body.lat), lng = Number(req.body.lng), raio = Math.round(Number(req.body.raio));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ erro: "Não consegui pegar a localização. Ligue a localização do celular e tente de novo." });
  if (!(raio >= 50 && raio <= 20000)) return res.status(400).json({ erro: "O raio precisa ser entre 50 e 20.000 metros." });
  await q("INSERT INTO config(chave,valor) VALUES('base_seg',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify({ lat, lng, raio })]);
  res.json({ ok: 1 });
}));
// Guarda a última posição do turno e avisa os gestores (sem som) quando o segurança SAI do raio
async function registrarPosicao(eu, geo, onde) {
  const t = await turnoAberto(eu.id); if (!t || geo.lat === null) return null;
  const b = await baseSeg(); const d = b ? distM(b, geo) : null;
  const fora = b ? d - Math.min(geo.precisao || 0, 500) > b.raio : false;
  await q("UPDATE turnos SET pos_lat=$1,pos_lng=$2,pos_prec=$3,pos_em=$4,fora=$5 WHERE id=$6", [geo.lat, geo.lng, geo.precisao !== null ? Math.round(geo.precisao) : null, Date.now(), fora, t.id]);
  if (fora && !t.fora) avisoSeguro({ gestor: true }, { title: `⚠ ${eu.nome} saiu da praça`, body: `${onde[0].toUpperCase() + onde.slice(1)}, ele estava a ${fmtDist(d)} do local de trabalho.`, tag: "longe" + t.id, silencioso: true });
  if (!fora && t.fora) avisoSeguro({ gestor: true }, { title: `✅ ${eu.nome} voltou para a praça`, body: "Está de novo dentro do local de trabalho.", tag: "longe" + t.id, silencioso: true });
  return { fora, d };
}
app.post("/api/seg/posicao", w(async (req, res) => {
  if (req.eu.tipo !== "func" || !req.eu.seguranca) return res.status(403).json({ erro: "Só para seguranças." });
  const lat = Number(req.body.lat), lng = Number(req.body.lng), prec = Number(req.body.precisao);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ erro: "Sem localização." });
  res.json({ ok: 1, ...(await registrarPosicao(req.eu, { lat, lng, precisao: Number.isFinite(prec) ? prec : null }, "pelo app aberto")) });
}));
const turnoAberto = async fid => (await q("SELECT * FROM turnos WHERE func_id=$1 AND fim IS NULL ORDER BY inicio DESC LIMIT 1", [fid]))[0];
// Foto do segurança: entrada (rosto), ronda (local 1..3) ou saída (rosto)
app.post("/api/seg/foto", express.raw({ type: () => true, limit: "8mb" }), w(async (req, res) => {
  if (req.eu.tipo !== "func" || !req.eu.seguranca) return res.status(403).json({ erro: "Só os seguranças usam esta área." });
  const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!/^image\/(jpeg|png|webp)$/.test(mime) || !req.body || !req.body.length) return res.status(400).json({ erro: "Envie uma foto (JPG ou PNG)." });
  const tipo = req.get("x-tipo"), agora = Date.now();
  const num = v => v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  const geo = { lat: num(req.get("x-lat")), lng: num(req.get("x-lng")), precisao: num(req.get("x-prec")) };
  if (geo.lat === null || geo.lng === null) geo.lat = geo.lng = geo.precisao = null;
  const marcarGeo = async () => {
    // Motivos para desconfiar da foto (o gestor vê ao lado da foto)
    const mot = [], tirada = num(req.get("x-tirada")), base = await baseSeg();
    if (req.get("x-origem") !== "camera") mot.push(tirada && agora - tirada > 3 * 60e3 ? `foto antiga (de ${new Date(tirada).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})` : "fora da câmera do app");
    if (geo.lat === null) mot.push("sem localização");
    else { if (geo.precisao > 300) mot.push(`local impreciso ±${Math.round(geo.precisao)} m`);
      if (base && distM(base, geo) - Math.min(geo.precisao || 0, 500) > base.raio) mot.push(`fora da praça ${fmtDist(distM(base, geo))}`); }
    await q("UPDATE seg_fotos SET lat=$1,lng=$2,precisao=$3,suspeita=$4 WHERE id=(SELECT f.id FROM seg_fotos f JOIN turnos t ON t.id=f.turno_id WHERE t.func_id=$5 ORDER BY f.id DESC LIMIT 1)", [geo.lat, geo.lng, geo.precisao !== null ? Math.round(geo.precisao) : null, mot.join(" · ") || null, req.eu.id]);
    if (geo.lat === null) return;
    await registrarPosicao(req.eu, geo, tipo === "ronda" ? "na foto da ronda" : tipo === "entrada" ? "na foto de chegada" : "na foto de saída");
  };
  let t = await turnoAberto(req.eu.id);
  if (tipo === "entrada") {
    if (t) return res.status(400).json({ erro: "Seu turno já está aberto." });
    [t] = await q("INSERT INTO turnos(func_id,inicio) VALUES($1,$2) RETURNING *", [req.eu.id, agora]);
    await q("INSERT INTO seg_fotos(turno_id,tipo,mime,tamanho,dados,em) VALUES($1,'entrada',$2,$3,$4,$5)", [t.id, mime, req.body.length, req.body, agora]);
    await marcarGeo();
    avisoSeguro({ gestor: true }, { title: `🟢 ${req.eu.nome} chegou`, body: "Turno de segurança iniciado. Toque para ver a foto.", tag: "seg" + t.id });
    return res.json({ ok: 1 });
  }
  if (!t) return res.status(400).json({ erro: "Primeiro registre a chegada com a foto do rosto." });
  if (tipo === "ronda") {
    const rodada = Math.floor((agora - Number(t.inicio)) / HORA), local = Number(req.get("x-local"));
    if (rodada < 1) return res.status(400).json({ erro: "A primeira ronda é 1 hora depois da chegada." });
    if (![0, 1, 2].includes(local)) return res.status(400).json({ erro: "Local inválido." });
    await q("DELETE FROM seg_fotos WHERE turno_id=$1 AND tipo='ronda' AND rodada=$2 AND local=$3", [t.id, rodada, local]);
    const nomeLocal = locaisDaRonda(listaLocais(req.eu.locais, await locais()), rodada)[local];
    await q("INSERT INTO seg_fotos(turno_id,tipo,rodada,local,local_nome,mime,tamanho,dados,em) VALUES($1,'ronda',$2,$3,$4,$5,$6,$7,$8)", [t.id, rodada, local, nomeLocal, mime, req.body.length, req.body, agora]);
    await marcarGeo();
    return res.json({ ok: 1 });
  }
  if (tipo === "saida") {
    await q("INSERT INTO seg_fotos(turno_id,tipo,mime,tamanho,dados,em) VALUES($1,'saida',$2,$3,$4,$5)", [t.id, mime, req.body.length, req.body, agora]);
    await marcarGeo();
    await q("UPDATE turnos SET fim=$1 WHERE id=$2", [agora, t.id]);
    avisoSeguro({ gestor: true }, { title: `🔴 ${req.eu.nome} encerrou o turno`, body: "Toque para ver as fotos do turno.", tag: "seg" + t.id });
    return res.json({ ok: 1 });
  }
  res.status(400).json({ erro: "Tipo de foto inválido." });
}));
app.get("/api/seg/fotos/:id", w(async (req, res) => {
  const [f] = await q("SELECT f.mime,f.dados,t.func_id FROM seg_fotos f JOIN turnos t ON t.id=f.turno_id WHERE f.id=$1", [req.params.id]);
  if (!f) return res.status(404).send("Foto não encontrada");
  if (req.eu.tipo !== "gestor" && !req.eu.panico && f.func_id !== req.eu.id) return res.status(403).send("Sem acesso");
  res.set("Content-Type", f.mime); res.set("Cache-Control", "private, max-age=86400"); res.send(f.dados);
}));
app.post("/api/seg/guardas", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  const turno = req.body.turno === "noite" ? "noite" : "dia", ini = horaOk(req.body.turno_ini), fim = horaOk(req.body.turno_fim);
  if (!ini || !fim) return res.status(400).json({ erro: "Informe o horário do turno (entrada e saída)." });
  const id = Number(req.body.id) || null;
  const ls = [...new Set((Array.isArray(req.body.locais) ? req.body.locais : []).map(x => String(x || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  if (ls.length < 3) return res.status(400).json({ erro: "Coloque pelo menos 3 locais de ronda (um por linha)." });
  if ((await q("SELECT 1 FROM funcionarios WHERE telefone=$1 AND id IS DISTINCT FROM $2", [tel, id])).length) return res.status(400).json({ erro: "Esse celular já está cadastrado." });
  if ((await q("SELECT 1 FROM funcionarios WHERE lower(nome)=lower($1) AND id IS DISTINCT FROM $2", [nome, id])).length) return res.status(400).json({ erro: "Já existe alguém com esse nome." });
  if (id) await q("UPDATE funcionarios SET nome=$1,telefone=$2,turno=$3,turno_ini=$4,turno_fim=$5,locais=$8,token=CASE WHEN telefone IS DISTINCT FROM $2 THEN $7 ELSE token END WHERE id=$6 AND seguranca",
    [nome, tel, turno, ini, fim, id, novoToken(), JSON.stringify(ls)]);
  else await q("INSERT INTO funcionarios(nome,telefone,token,criado,seguranca,turno,turno_ini,turno_fim,locais) VALUES($1,$2,$3,$4,true,$5,$6,$7,$8)", [nome, tel, novoToken(), Date.now(), turno, ini, fim, JSON.stringify(ls)]);
  res.json({ ok: 1 });
}));
app.post("/api/seg/locais", gestor, w(async (req, res) => {
  const l = (Array.isArray(req.body.locais) ? req.body.locais : []).map((x, i) => txt(x, 40) || LOCAIS_PADRAO[i]).slice(0, 3);
  if (l.length !== 3) return res.status(400).json({ erro: "Informe os 3 locais." });
  await q("INSERT INTO config(chave,valor) VALUES('locais_seg',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify(l)]);
  res.json({ ok: 1 });
}));
// Data e hora digitadas pelo gestor (horário de São Paulo, sem horário de verão)
const horaSP = v => { const m = String(v || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/); return m ? Date.parse(`${m[1]}T${m[2]}:00-03:00`) : NaN; };
// Gestor encerra o turno (ou corrige a hora de saída) quando o segurança errou ou esqueceu
app.post("/api/seg/turnos/:id/encerrar", gestor, w(async (req, res) => {
  const [t] = await q("SELECT * FROM turnos WHERE id=$1", [req.params.id]); if (!t) return res.status(404).json({ erro: "Turno não encontrado." });
  const fim = req.body.fim ? horaSP(req.body.fim) : Date.now();
  if (!Number.isFinite(fim)) return res.status(400).json({ erro: "Informe a data e a hora de saída." });
  if (fim <= Number(t.inicio)) return res.status(400).json({ erro: "A saída precisa ser depois da chegada (" + new Date(Number(t.inicio)).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + ")." });
  if (fim > Date.now() + 60e3) return res.status(400).json({ erro: "A saída não pode ser no futuro." });
  await q("UPDATE turnos SET fim=$1, encerrado_por=$2 WHERE id=$3", [fim, req.eu.nome || "Gestor", t.id]); res.json({ ok: 1 });
}));
// Turno aberto por engano: o gestor apaga (com as fotos dele)
app.post("/api/seg/turnos/:id/apagar", gestor, w(async (req, res) => {
  await q("DELETE FROM turnos WHERE id=$1", [req.params.id]); res.json({ ok: 1 });
}));
// Relatório para pagamento: turnos de cada segurança num período
app.get("/api/seg/relatorio", gestor, w(async (req, res) => {
  const de = horaSP((req.query.de || "") + "T00:00"), ate = horaSP((req.query.ate || "") + "T00:00") + 24 * HORA;
  if (!Number.isFinite(de) || !Number.isFinite(ate) || ate <= de) return res.status(400).json({ erro: "Escolha as datas de início e fim." });
  const turnos = await q(`SELECT t.id,t.func_id,t.inicio,t.fim,t.encerrado_por,f.nome,f.telefone,f.turno,
      (SELECT count(*) FROM seg_fotos s WHERE s.turno_id=t.id AND s.tipo='ronda')::int AS fotos_ronda,
      (SELECT count(*) FROM (SELECT rodada FROM seg_fotos x WHERE x.turno_id=t.id AND x.tipo='ronda' GROUP BY rodada HAVING count(DISTINCT local)=3) z)::int AS rondas_ok,
      EXISTS(SELECT 1 FROM seg_fotos s WHERE s.turno_id=t.id AND s.tipo='entrada') AS foto_entrada,
      EXISTS(SELECT 1 FROM seg_fotos s WHERE s.turno_id=t.id AND s.tipo='saida') AS foto_saida,
      (SELECT count(*) FROM seg_fotos s WHERE s.turno_id=t.id AND s.suspeita IS NOT NULL)::int AS suspeitas
    FROM turnos t JOIN funcionarios f ON f.id=t.func_id WHERE t.inicio >= $1 AND t.inicio < $2 ORDER BY f.nome, t.inicio`, [de, ate]);
  res.json({ turnos });
}));
// Botão de pânico: avisa quem recebe o pânico (ex.: Alex) e a gestão
// Aviso no WhatsApp dos gestores, sem alarme (CallMeBot: grátis, cada gestor ativa no próprio número)
async function zapLista() { const [r] = await q("SELECT valor FROM config WHERE chave='zap_panico'"); return r ? JSON.parse(r.valor) : []; }
const zapAvisados = new Set();
async function zapGestores(texto, chave) {
  if (chave && zapAvisados.has(chave)) return; if (chave) zapAvisados.add(chave);
  for (const z of await zapLista()) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=55${z.telefone}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(z.apikey)}`;
    fetch(url, { signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) console.error("whatsapp", z.nome, r.status); }).catch(e => console.error("whatsapp", z.nome, e.message));
  }
}
app.post("/api/seg/zap", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60), tel = fone(req.body.telefone), apikey = txt(req.body.apikey, 40);
  if (!nome || !tel || !apikey) return res.status(400).json({ erro: "Preencha nome, celular e a chave que o CallMeBot mandou." });
  const l = (await zapLista()).filter(z => z.telefone !== tel); l.push({ nome, telefone: tel, apikey });
  await q("INSERT INTO config(chave,valor) VALUES('zap_panico',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify(l)]);
  try {
    const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=55${tel}&text=${encodeURIComponent("✅ Teste: você vai receber aqui os avisos de PÂNICO dos seguranças (app Natal Osasco).")}&apikey=${encodeURIComponent(apikey)}`, { signal: AbortSignal.timeout(20000) });
    const corpo = await r.text();
    if (!r.ok || /error|invalid|not/i.test(corpo.slice(0, 300)) && !/queued|sent/i.test(corpo)) return res.json({ ok: 1, aviso: "Salvei, mas o teste não confirmou o envio. Confira a chave." });
  } catch (e) { return res.json({ ok: 1, aviso: "Salvei, mas não consegui testar agora." }); }
  res.json({ ok: 1 });
}));
app.post("/api/seg/zap/remover", gestor, w(async (req, res) => {
  const l = (await zapLista()).filter(z => z.telefone !== fone(req.body.telefone));
  await q("INSERT INTO config(chave,valor) VALUES('zap_panico',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify(l)]);
  res.json({ ok: 1 });
}));
async function listaPanicos(soFunc) {
  return q(`SELECT p.*, f.nome, f.telefone FROM panicos p JOIN funcionarios f ON f.id=p.func_id
    WHERE p.em > $1 ${soFunc ? "AND p.func_id=$2" : ""} ORDER BY p.em DESC LIMIT 30`, soFunc ? [Date.now() - 24 * HORA, soFunc] : [Date.now() - 24 * HORA]);
}
app.post("/api/seg/panico", w(async (req, res) => {
  if (req.eu.tipo !== "func" || !req.eu.seguranca) return res.status(403).json({ erro: "Só os seguranças usam o botão de pânico." });
  const n = v => Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null;
  const lat = n(req.body.lat), lng = n(req.body.lng);
  // Evita vários alarmes seguidos do mesmo segurança: reaproveita o aberto dos últimos 2 minutos
  let [p] = await q("SELECT * FROM panicos WHERE func_id=$1 AND atendido_em IS NULL AND em > $2 ORDER BY em DESC LIMIT 1", [req.eu.id, Date.now() - 120e3]);
  if (p) { if (lat !== null && p.lat === null) await q("UPDATE panicos SET lat=$1,lng=$2,precisao=$3 WHERE id=$4", [lat, lng, n(req.body.precisao), p.id]); }
  else [p] = await q("INSERT INTO panicos(func_id,em,lat,lng,precisao) VALUES($1,$2,$3,$4,$5) RETURNING *", [req.eu.id, Date.now(), lat, lng, n(req.body.precisao)]);
  const quem = (await q("SELECT id FROM funcionarios WHERE panico")).map(r => r.id);
  const payload = { title: `🆘 PÂNICO: ${req.eu.nome}`, body: `${req.eu.nome} pediu ajuda às ${new Date(Number(p.em)).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}. Abra o app para ver o local e ligar.`, tag: "panico" + p.id, alarme: true };
  await avisarCelular({ func: quem }, payload).catch(e => console.error("panico push", e.message));
  const mapa = p.lat !== null && p.lat !== undefined ? `\nLocal: https://maps.google.com/?q=${p.lat},${p.lng}` : (lat !== null ? `\nLocal: https://maps.google.com/?q=${lat},${lng}` : "");
  // Gestores: aviso no celular SEM som (pedido do Bruce: sem alarme)
  avisoSeguro({ gestor: true }, { title: `🆘 PÂNICO: ${req.eu.nome}`, body: `${req.eu.nome} pediu ajuda às ${new Date(Number(p.em)).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}. O Alex já foi alarmado. Toque para ver o local.`, tag: "panico-g" + p.id, silencioso: true });
  zapGestores(`🆘 *PÂNICO*: ${req.eu.nome} pediu ajuda às ${new Date(Number(p.em)).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}.${mapa}\nVeja no app: https://natal-osasco.onrender.com`, p.id);
  res.json({ ok: 1, id: p.id });
}));
app.post("/api/panicos/:id/atender", w(async (req, res) => {
  if (!(req.eu.tipo === "gestor" || req.eu.panico)) return res.status(403).json({ erro: "Sem acesso." });
  await q("UPDATE panicos SET atendido_por=COALESCE(atendido_por,$1), atendido_em=COALESCE(atendido_em,$2) WHERE id=$3", [req.eu.nome || "Gestor", Date.now(), req.params.id]);
  const [p] = await q("SELECT func_id FROM panicos WHERE id=$1", [req.params.id]);
  if (p) avisoSeguro({ func: [p.func_id] }, { title: "✅ Ajuda a caminho", body: `${req.eu.nome || "A gestão"} viu o seu pedido de ajuda.`, tag: "panico-ok" + req.params.id });
  res.json({ ok: 1 });
}));
app.post("/api/seg/centrais", gestor, w(async (req, res) => {
  const nome = txt(req.body.nome, 60); if (!nome) return res.status(400).json({ erro: "Informe o nome." });
  const tel = fone(req.body.telefone); if (!tel) return res.status(400).json({ erro: "Informe o celular com DDD, ex.: 11 98765-4321." });
  const [ex] = await q("SELECT id,seguranca FROM funcionarios WHERE telefone=$1", [tel]);
  if (ex && ex.seguranca) return res.status(400).json({ erro: "Esse celular é de um segurança." });
  if (ex) await q("UPDATE funcionarios SET panico=true WHERE id=$1", [ex.id]);
  else await q("INSERT INTO funcionarios(nome,telefone,token,criado,panico) VALUES($1,$2,$3,$4,true)", [nome, tel, novoToken(), Date.now()]);
  res.json({ ok: 1 });
}));
app.post("/api/seg/centrais/:id/remover", gestor, w(async (req, res) => {
  await q("UPDATE funcionarios SET panico=false WHERE id=$1", [req.params.id]);
  res.json({ ok: 1 });
}));
// Teste de alarme: o gestor dispara um alarme de TESTE para quem recebe o pânico e vê quando a pessoa confirmou
async function testesAlarme() { const [r] = await q("SELECT valor FROM config WHERE chave='testes_alarme'"); return r ? JSON.parse(r.valor) : []; }
async function salvarTestes(l) { await q("INSERT INTO config(chave,valor) VALUES('testes_alarme',$1) ON CONFLICT(chave) DO UPDATE SET valor=$1", [JSON.stringify(l.slice(-20))]); }
app.post("/api/seg/centrais/:id/testar", gestor, w(async (req, res) => {
  const id = Number(req.params.id); const [f] = await q("SELECT id,nome FROM funcionarios WHERE id=$1 AND panico", [id]);
  if (!f) return res.status(404).json({ erro: "Pessoa não encontrada." });
  const l = (await testesAlarme()).filter(t => !(t.para === id && !t.ok));
  const t = { id: Date.now(), para: id, nome: f.nome, por: req.eu.nome || "Gestor", em: Date.now(), ok: null }; l.push(t); await salvarTestes(l);
  const n = await avisarCelular({ func: [id] }, { title: "🔔 TESTE de alarme do pânico", body: `Isto é só um TESTE enviado por ${t.por}. Abra o app e toque em "Ouvi o alarme".`, tag: "teste" + t.id, alarme: true }).catch(() => 0);
  res.json({ ok: 1, celulares: n || 0 });
}));
app.post("/api/teste-alarme/ok", w(async (req, res) => {
  if (!req.eu.panico) return res.status(403).json({ erro: "Sem acesso." });
  const l = await testesAlarme(); for (const t of l) if (t.para === req.eu.id && !t.ok) t.ok = Date.now(); await salvarTestes(l);
  avisoSeguro({ gestor: true }, { title: "✅ Teste de alarme confirmado", body: `${req.eu.nome} ouviu o alarme de teste.`, tag: "teste-ok" });
  res.json({ ok: 1 });
}));

// Alarme de hora em hora (aviso no celular do segurança)
async function verificarRondas() {
  const abertos = await q("SELECT t.*, f.nome, f.locais FROM turnos t JOIN funcionarios f ON f.id=t.func_id WHERE t.fim IS NULL");
  for (const t of abertos) {
    const rodada = Math.floor((Date.now() - Number(t.inicio)) / HORA);
    if (rodada >= 1 && rodada > t.ronda_avisada && rodada <= 24) {
      await q("UPDATE turnos SET ronda_avisada=$1 WHERE id=$2", [rodada, t.id]);
      const nomes = locaisDaRonda(listaLocais(t.locais, await locais()), rodada).join(", ");
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
