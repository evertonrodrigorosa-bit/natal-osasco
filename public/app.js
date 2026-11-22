(function () {
"use strict";
const TZ = "America/Sao_Paulo";
const app = document.getElementById("app");
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };

const novoWz = () => ({ passo: 1, pessoas: new Set(), prazo: "", prioridade: "", titulo: "", detalhes: "", arquivos: [], criada: null });
const S = { chave: ls.get("chave"), d: null, tab: null, open: new Set(), err: "", busy: false, entrarGestor: false, confirm: null,
  ed: null, editingObs: null, wz: novoWz(), fPrio: "todas", fStatus: "abertas", fPessoa: "", lembreteVisto: false, escondidoEm: 0 };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDT = ms => ms ? new Date(Number(ms)).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtH = ms => new Date(Number(ms)).toLocaleString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtD = s => { if (!s) return "Sem prazo"; const [dt, hr] = s.split("T"); const [y, m, d] = dt.split("-"); return `${d}/${m}/${y}` + (hr ? ` às ${hr}` : ""); };
const agora = () => new Date().toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16).replace(" ", "T");
const atrasado = p => !!p && (p.includes("T") ? p < agora() : p < agora().slice(0, 10));
const PRIO = { alta: { l: "Alta", i: "🔴", r: 0 }, normal: { l: "Normal", i: "🟡", r: 1 }, baixa: { l: "Baixa", i: "🟢", r: 2 } };
const prio = t => PRIO[t.prioridade] ? t.prioridade : "normal";

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json", "x-chave": S.chave || "" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== "/api/gestor") { S.chave = null; ls.set("chave", null); S.d = null; draw(); }
  if (!r.ok) throw new Error(j.erro || "Falha de conexão");
  return j;
}

/* ---------- dados ---------- */
const G = () => S.d && S.d.eu.tipo === "gestor";
const EU = () => S.d && S.d.eu.id;
const pessoasDe = t => S.d.pessoas.filter(p => p.tarefa_id === t.id).sort((a, b) => nome(a.func_id).localeCompare(nome(b.func_id)));
const minha = t => S.d.pessoas.find(p => p.tarefa_id === t.id && p.func_id === EU());
const nome = id => { const f = S.d.funcionarios.find(x => x.id === id); return f ? f.nome : "Removido"; };
const setorNome = t => t.setor_id ? ((S.d.setores || []).find(s => s.id === t.setor_id) || {}).nome || "" : "";
function estadoP(p, t) {
  if (p.fim) return "ok";
  const late = atrasado(t.prazo);
  if (p.inicio) return late ? "late-run" : "run";
  return late ? "late" : "pend";
}
// Situação da tarefa: para o colaborador, a dele; para o gestor, do grupo todo
function estado(t) {
  if (!G()) { const m = minha(t); return m ? estadoP(m, t) : "pend"; }
  const ps = pessoasDe(t);
  if (ps.length && ps.every(p => p.fim)) return "ok";
  const late = atrasado(t.prazo);
  if (ps.some(p => p.inicio)) return late ? "late-run" : "run";
  return late ? "late" : "pend";
}
const aberta = t => estado(t) !== "ok";
const ordenar = (a, b) => (PRIO[prio(a)].r - PRIO[prio(b)].r) || (a.prazo || "9999").localeCompare(b.prazo || "9999") || a.id - b.id;

function vistas() { try { return new Set(JSON.parse(ls.get("vistas_" + EU()) || "[]")); } catch (e) { return new Set(); } }
function marcarVistas(ids) { const v = vistas(); ids.forEach(i => v.add(i)); ls.set("vistas_" + EU(), JSON.stringify([...v])); }
function novas() {
  if (!S.d || G()) return [];
  const v = vistas();
  return S.d.tarefas.filter(t => { const m = minha(t); return m && !m.ciente && !m.fim && !v.has(t.id); }).sort(ordenar);
}
let ultimoAviso = null;
function avisar() {
  const n = novas(), ids = n.map(t => t.id).join(",");
  if (ultimoAviso !== null && ids && ids !== ultimoAviso && n.some(t => !ultimoAviso.split(",").includes(String(t.id)))) {
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
    const msg = n.length === 1 ? n[0].descricao : n.length + " tarefas novas para você";
    if ("Notification" in window && Notification.permission === "granted" && !ls.get(chavePush()))
      navigator.serviceWorker && navigator.serviceWorker.ready.then(r => r.showNotification("Tarefa nova", { body: msg, icon: "/icon-192.png", tag: "nova" })).catch(() => {});
  }
  ultimoAviso = ids;
}
async function carregar() {
  if (!S.chave) return;
  try { S.d = await api("GET", "/api/estado"); if (S.err.startsWith("Sem conexão")) S.err = ""; avisar(); renovarPush(); }
  catch (e) { if (S.chave) S.err = "Sem conexão com o servidor. Tentando de novo…"; }
  render();
}
const fmtTel = d => !d ? "" : d.length === 11 ? `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}` : `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
const zap = (id, texto) => { const f = S.d.funcionarios.find(x => x.id === id); return f && f.telefone ? `https://wa.me/55${f.telefone}?text=${encodeURIComponent(texto)}` : null; };
const msgNova = (fid, t) => `Olá ${nome(fid)}, você tem uma tarefa nova (prioridade ${PRIO[prio(t)].l.toUpperCase()}): ${t.descricao}. Entrega: ${fmtD(t.prazo)}. Abra o app, aperte INICIAR quando começar e TERMINAR quando acabar: ${location.origin}`;

/* ---------- render ---------- */
let pending = false;
function render() {
  const a = document.activeElement;
  if (a && app.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "file")) && a.value) { pending = true; return; }
  pending = false; draw();
}
document.addEventListener("focusout", () => setTimeout(() => { if (pending) render(); }, 60));

function draw() {
  const keep = {};
  app.querySelectorAll("input[id],textarea[id],select[id]").forEach(el => { if (el.type !== "file") keep[el.id] = el.value; });
  try { drawInner(); } finally {
    for (const id in keep) { const el = document.getElementById(id); if (el && app.contains(el) && el.value !== keep[id] && keep[id] !== "") el.value = keep[id]; }
  }
}
const chip = (act, k, on, label) => `<button data-act="${act}" data-k="${k}" class="${on ? "on" : ""}">${label}</button>`;

function drawInner() {
  const role = document.getElementById("role"), stats = document.getElementById("stats");
  let h = S.err ? `<div class="banner">${esc(S.err)}</div>` : "";
  if (S.enviandoFoto) h += `<div class="aviso"><b>📸 Enviando a foto e terminando a tarefa…</b></div>`;
  if (!S.chave || !S.d) {
    role.hidden = true; stats.innerHTML = "";
    if (S.chave && !S.d) { app.innerHTML = h + `<div class="empty">Carregando…</div>`; return; }
    app.innerHTML = h + entrada(); const f = app.querySelector("[data-autofocus]"); if (f) f.focus(); return;
  }
  role.hidden = false; role.textContent = (G() ? "Gestor" : S.d.eu.nome) + " · Sair";
  const ts = S.d.tarefas, c = { pend: 0, run: 0, ok: 0, late: 0 };
  ts.forEach(t => { const e = estado(t); if (e === "ok") c.ok++; else if (e === "run" || e === "late-run") c.run++; else c.pend++; if (e.startsWith("late")) c.late++; });
  stats.innerHTML = `<span>${c.pend} a iniciar</span><span>${c.run} em andamento</span><span>${c.ok} concluídas</span>${c.late ? `<span>${c.late} atrasadas</span>` : ""}`;

  if (G()) {
    const tabs = [["nova", "＋ Nova tarefa"], ["acompanhar", "Acompanhar"], ["equipe", "Equipe"]];
    if (!S.tab || !tabs.some(x => x[0] === S.tab)) S.tab = "nova";
    h += `<nav class="tabs">${tabs.map(([k, l]) => chip("tab", k, S.tab === k, l)).join("")}</nav>`;
    if (S.tab !== "equipe") h += alertas() + botaoPush();
    h += S.tab === "nova" ? wizard() : S.tab === "equipe" ? equipe() : acompanhar();
  } else h += colaborador();
  app.innerHTML = h;
  const f = app.querySelector("[data-autofocus]"); if (f) f.focus();
}
function confirmBtn(act, id, label) {
  const on = S.confirm === act + ":" + id;
  return `<button class="ghost danger" data-act="${on ? act : "ask"}" data-k="${act}" data-id="${id}">${on ? "Confirmar?" : label}</button>`;
}

function entrada() {
  if (S.entrarGestor) return `<div class="welcome"><h2>Entrar como gestor</h2></div><div class="panel">
    <label class="f">Senha do gestor<input id="senha" type="password" autocomplete="current-password" data-autofocus></label>
    <button class="primary big" data-act="login-g">Entrar</button><button class="ghost" data-act="voltar">Voltar</button></div>`;
  let h = `<div class="welcome"><h2>Entrar</h2><p class="note">Digite o seu celular, o mesmo que você passou para o gestor. Depois disso o app já abre direto na sua lista.</p></div>
  <div class="panel"><label class="f">Seu celular com DDD<input id="tel" type="tel" inputmode="numeric" autocomplete="tel" placeholder="11 98765-4321" data-autofocus></label>
  <button class="primary big" data-act="login-f">Entrar</button></div>`;
  return h + `<div style="margin-top:28px;text-align:center"><button class="ghost" data-act="ir-gestor">Sou o gestor</button></div>`;
}

/* ---------- colaborador ---------- */
function colaborador() {
  const minhas = S.d.tarefas.filter(t => minha(t));
  const abertas = minhas.filter(aberta), andando = abertas.filter(t => minha(t).inicio);
  let h = "";
  // Lembrete fixo: sempre visível enquanto houver tarefa aberta
  if (andando.length) {
    h += `<div class="lembrete run" role="status"><b>⏱ Você está trabalhando em:</b>`;
    andando.sort(ordenar).forEach(t => h += `<div class="lem-row"><span>${PRIO[prio(t)].i} ${esc(t.descricao)} <small>desde ${fmtDT(minha(t).inicio)}</small></span><button class="primary" data-act="terminar" data-id="${t.id}">📸 Terminar</button></div>`);
    h += `<small>Acabou? Aperte TERMINAR e tire a foto do trabalho pronto.</small></div>`;
  } else if (abertas.length) {
    h += `<div class="lembrete" role="status"><span><b>👉 Lembrete:</b> na hora de começar, abra a tarefa e aperte <b>▶ INICIAR</b>. Quando acabar, aperte <b>■ TERMINAR</b>. É assim que a gestão acompanha o trabalho.</span></div>`;
  }
  // Barra fixa no rodapé: o lembrete fica na tela mesmo rolando a lista
  if (andando.length === 1) { const t = andando[0]; h += `<div class="barra run"><span>⏱ Em andamento: <b>${esc(t.descricao)}</b></span><button data-act="terminar" data-id="${t.id}">📸 Terminar</button></div>`; }
  else if (andando.length) h += `<div class="barra run"><span>⏱ <b>${andando.length} tarefas em andamento.</b> Aperte TERMINAR em cada uma quando acabar.</span><button data-act="topo">Ver</button></div>`;
  else if (abertas.length) h += `<div class="barra"><span>👉 Começou? Aperte <b>▶ INICIAR</b>. Acabou? Aperte <b>■ TERMINAR</b>.</span></div>`;
  const nv = novas();
  if (nv.length) h += `<div class="aviso"><b>🔔 ${nv.length === 1 ? "Você tem uma tarefa nova" : "Você tem " + nv.length + " tarefas novas"}</b>
    <span>${nv.map(t => PRIO[prio(t)].i + " " + esc(t.descricao)).join(" · ")}</span>
    <div class="row"><button class="primary" data-act="ver-novas">Ver agora</button></div></div>`;
  h += botaoPush();

  // Lembrete ao abrir o app
  if (!S.lembreteVisto && abertas.length) h += `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="lem-t"><div class="modal-c">
    <h2 id="lem-t">Olá, ${esc(S.d.eu.nome)}!</h2>
    <p style="margin:0">Você tem <b>${abertas.length} ${abertas.length === 1 ? "tarefa aberta" : "tarefas abertas"}</b>${andando.length ? `, e ${andando.length === 1 ? "uma está" : andando.length + " estão"} em andamento` : ""}.</p>
    <ol><li>Abra a tarefa: quem criou e os colegas já ficam sabendo que você está ciente.</li>
    <li>Aperte <b>▶ INICIAR</b> na hora que começar o trabalho.</li>
    <li>Aperte <b>■ TERMINAR</b> quando acabar. Sem isso, o app continua contando como se você ainda estivesse nessa tarefa.</li></ol>
    <button class="primary big" data-act="lembrete-ok">Entendi</button></div></div>`;

  const cont = k => abertas.filter(t => k === "todas" || prio(t) === k).length;
  h += `<p class="h3" style="margin-top:16px">Prioridade</p><nav class="tabs prio">${chip("fprio", "todas", S.fPrio === "todas", `Todas (${cont("todas")})`)}${Object.entries(PRIO).map(([k, p]) => chip("fprio", k, S.fPrio === k, `${p.i} ${p.l} (${cont(k)})`)).join("")}</nav>`;
  if (!["abertas", "concluidas"].includes(S.fStatus)) S.fStatus = "abertas";
  h += `<nav class="tabs st" style="padding-top:6px">${chip("fstatus", "abertas", S.fStatus === "abertas", "A fazer")}${chip("fstatus", "concluidas", S.fStatus === "concluidas", "Concluídas")}</nav>`;
  let list = minhas.filter(t => (S.fStatus === "abertas") === aberta(t) && (S.fPrio === "todas" || prio(t) === S.fPrio));
  list.sort(S.fStatus === "abertas" ? ordenar : (a, b) => (minha(b).fim || 0) - (minha(a).fim || 0));
  if (!list.length) return h + `<div class="empty">${!minhas.length ? "Nenhuma tarefa no seu nome por enquanto." : S.fStatus === "abertas" ? "Nada a fazer neste filtro. 🎉" : "Nenhuma tarefa concluída neste filtro."}</div>`;
  return h + lista(list, S.fStatus === "abertas" && S.fPrio === "todas");
}
function lista(list, agrupar) {
  let h = "";
  if (!agrupar) return `<div class="list">${list.map(card).join("")}</div>`;
  for (const [k, p] of Object.entries(PRIO)) {
    const grp = list.filter(t => prio(t) === k); if (!grp.length) continue;
    h += `<section class="grupo"><div class="grupo-h p-${k}"><h2>${p.i} Prioridade ${p.l.toLowerCase()}</h2><span class="cnt">${grp.length}</span></div><div class="list">${grp.map(card).join("")}</div></section>`;
  }
  return h;
}

/* ---------- gestor: nova tarefa (passo a passo) ---------- */
function wizard() {
  const W = S.wz, fs = S.d.funcionarios;
  if (W.criada) {
    const t = S.d.tarefas.find(x => x.id === W.criada);
    let h = `<div class="panel ok-panel"><h2 class="wz-t">✔ Tarefa criada</h2>`;
    if (t) {
      h += `<p style="margin:0"><b>${esc(t.descricao)}</b><br><span class="note">${PRIO[prio(t)].i} ${PRIO[prio(t)].l} · 📅 ${fmtD(t.prazo)}</span></p><p class="h3">Avisar no WhatsApp</p><div class="row">`;
      pessoasDe(t).forEach(p => { const l = zap(p.func_id, msgNova(p.func_id, t)); h += l ? `<a class="zap" href="${l}" target="_blank" rel="noopener">📲 ${esc(nome(p.func_id))}</a>` : `<span class="note">${esc(nome(p.func_id))}: sem celular</span>`; });
      h += `</div>`;
    }
    return h + `<div class="row"><button class="primary big" data-act="wz-outra">＋ Criar outra</button><button class="big" data-act="tab" data-k="acompanhar">Acompanhar</button></div></div>`;
  }
  const nomes = ["Colaboradores", "Data e hora da entrega", "Prioridade", "Título e anexos"];
  let h = `<div class="steps">${nomes.map((n, i) => `<span class="${i + 1 === W.passo ? "on" : i + 1 < W.passo ? "feito" : ""}">${i + 1}</span>`).join("")}<b>${W.passo}. ${nomes[W.passo - 1]}</b></div>`;
  const sel = [...W.pessoas].filter(id => fs.some(f => f.id === id));
  const resumo = () => `<div class="resumo">${sel.map(id => `<span class="pill">👤 ${esc(nome(id))}</span>`).join("")}${W.prazo && W.passo > 2 ? `<span class="pill">📅 ${fmtD(W.prazo)}</span>` : ""}${W.prioridade && W.passo > 3 ? `<span class="pill p-${W.prioridade}">${PRIO[W.prioridade].i} ${PRIO[W.prioridade].l}</span>` : ""}</div>`;
  if (W.passo === 1) {
    if (!fs.length) return h + `<div class="empty">Ninguém cadastrado ainda. Vá na aba <b>Equipe</b> e cadastre os colaboradores (nome e celular).</div>`;
    const ms = S.d.modelos || [];
    if (ms.length) h += `<p class="h3" style="margin-top:14px">⚡ Modelos: toque para usar</p><div class="modelos">${ms.map(m => `<div class="modelo"><button data-act="wz-modelo" data-id="${m.id}"><span class="prio-txt p-${PRIO[m.prioridade] ? m.prioridade : "normal"}">${PRIO[m.prioridade] ? PRIO[m.prioridade].i : "🟡"}</span> ${esc(m.titulo)}<small>${esc(m.pessoas.filter(id => fs.some(f => f.id === id)).map(nome).join(", ") || "escolher pessoas")}</small></button>${confirmBtn("del-modelo", m.id, "✕")}</div>`).join("")}</div><p class="h3" style="margin-top:14px">Ou escolha as pessoas</p>`;
    h += `<p class="note">Toque em uma pessoa ou em várias para criar a tarefa.</p><div class="names">`;
    for (const f of fs) {
      const n = S.d.tarefas.filter(t => { const p = S.d.pessoas.find(x => x.tarefa_id === t.id && x.func_id === f.id); return p && !p.fim; }).length;
      h += `<button data-act="wz-pessoa" data-id="${f.id}" class="${W.pessoas.has(f.id) ? "on" : ""}" aria-pressed="${W.pessoas.has(f.id)}">${W.pessoas.has(f.id) ? "✔ " : ""}${esc(f.nome)}<small>${n} em aberto</small></button>`;
    }
    h += `</div><div class="row" style="margin-top:10px"><button class="ghost" data-act="wz-todos">${sel.length === fs.length ? "Limpar seleção" : "Selecionar todos"}</button></div>`;
    return h + `<div class="wz-nav"><button class="primary big" data-act="wz-ir" data-k="2" ${sel.length ? "" : "disabled"}>Continuar${sel.length ? ` (${sel.length} ${sel.length === 1 ? "pessoa" : "pessoas"})` : ""} →</button></div>`;
  }
  h += resumo();
  if (W.passo === 2) {
    const hoje = agora().slice(0, 10), am = new Date(Date.now() + 864e5).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 10);
    h += `<div class="panel"><label class="f">Entregar até (dia e hora)<input id="wz-prazo" type="datetime-local" value="${esc(W.prazo)}" data-autofocus></label>
      <div class="row">${[[hoje + "T12:00", "Hoje 12h"], [hoje + "T18:00", "Hoje 18h"], [am + "T08:00", "Amanhã 8h"], [am + "T18:00", "Amanhã 18h"]].map(([v, l]) => `<button data-act="wz-rapido" data-k="${v}" class="${W.prazo === v ? "on" : ""}">${l}</button>`).join("")}</div></div>`;
    return h + `<div class="wz-nav"><button class="big" data-act="wz-ir" data-k="1">← Voltar</button><button class="primary big" data-act="wz-ir" data-k="3">Continuar →</button></div>`;
  }
  if (W.passo === 3) {
    h += `<div class="prio-btns">${Object.entries(PRIO).map(([k, p]) => `<button class="big p-${k} ${W.prioridade === k ? "on" : ""}" data-act="wz-prio" data-k="${k}">${p.i} ${p.l}</button>`).join("")}</div>`;
    return h + `<div class="wz-nav"><button class="big" data-act="wz-ir" data-k="2">← Voltar</button></div>`;
  }
  h += `<div class="panel"><label class="f">Título<input id="wz-titulo" maxlength="200" value="${esc(W.titulo)}" placeholder="Ex.: Instalar cascata de luz na fachada" data-autofocus></label>
    <label class="f">Detalhes (opcional)<textarea id="wz-det" maxlength="1000" placeholder="Local, material, observações…">${esc(W.detalhes)}</textarea></label>
    <p class="h3">Anexos</p>${W.arquivos.length ? `<div class="arqs">${W.arquivos.map((f, i) => `<span class="pill">📎 ${esc(f.name)} <button class="ghost" data-act="wz-tira" data-id="${i}" aria-label="Tirar ${esc(f.name)}">✕</button></span>`).join("")}</div>` : ""}
    <label class="upl"><input type="file" id="wz-arq" accept="${ACEITA}" multiple hidden>📎 Anexar arquivo (foto, PDF, Word, Excel)</label>
    ${W.modelo ? `<p class="note">⚡ Usando o modelo “${esc(W.modelo)}”.</p>` : `<label class="check"><input type="checkbox" id="wz-salvar" ${W.salvarModelo ? "checked" : ""}> Salvar como modelo para usar de novo</label>`}</div>`;
  return h + `<div class="wz-nav"><button class="big" data-act="wz-ir" data-k="3">← Voltar</button><button class="primary big" data-act="wz-criar">✔ Criar tarefa</button></div>`;
}
const ACEITA = "image/*,.jpg,.jpeg,.png,.heic,.pdf,application/pdf,.doc,.docx,.xls,.xlsx,.txt";

/* ---------- gestor: acompanhar ---------- */
function acompanhar() {
  const ts = S.d.tarefas;
  let h = `<p class="h3" style="margin-top:12px">Prioridade</p><nav class="tabs prio">${chip("fprio", "todas", S.fPrio === "todas", "Todas")}${Object.entries(PRIO).map(([k, p]) => chip("fprio", k, S.fPrio === k, `${p.i} ${p.l}`)).join("")}</nav>`;
  const st = [["abertas", "Abertas"], ["andamento", "Em andamento"], ["atrasadas", "Atrasadas"], ["concluidas", "Concluídas"], ["todas", "Todas"]];
  if (!st.some(x => x[0] === S.fStatus)) S.fStatus = "abertas";
  h += `<nav class="tabs st" style="padding-top:6px">${st.map(([k, l]) => chip("fstatus", k, S.fStatus === k, l)).join("")}</nav>`;
  h += `<label class="f" style="margin-top:8px">Colaborador<select id="f-pessoa" data-act-change="fpessoa"><option value="">Todos</option>${S.d.funcionarios.map(f => `<option value="${f.id}" ${String(f.id) === S.fPessoa ? "selected" : ""}>${esc(f.nome)}</option>`).join("")}</select></label>`;
  const okSt = t => { const e = estado(t); switch (S.fStatus) {
    case "abertas": return e !== "ok"; case "andamento": return e === "run" || e === "late-run";
    case "atrasadas": return e === "late" || e === "late-run"; case "concluidas": return e === "ok"; default: return true; } };
  const list = ts.filter(t => okSt(t) && (S.fPrio === "todas" || prio(t) === S.fPrio) && (!S.fPessoa || S.d.pessoas.some(p => p.tarefa_id === t.id && String(p.func_id) === S.fPessoa)));
  const fimDe = t => Math.max(0, ...pessoasDe(t).map(p => p.fim || 0));
  list.sort(S.fStatus === "concluidas" ? (a, b) => fimDe(b) - fimDe(a) : ordenar);
  if (!ts.length) return h + `<div class="empty">Nenhuma tarefa ainda. Use <b>＋ Nova tarefa</b> para criar a primeira.</div>`;
  if (!list.length) return h + `<div class="empty">Nada neste filtro.</div>`;
  return h + lista(list, S.fPrio === "todas" && S.fStatus !== "concluidas");
}

function equipe() {
  const fs = S.d.funcionarios;
  let h = `<div class="panel"><p class="h3">Novo colaborador</p><div class="grid2"><label class="f">Nome<input id="nf-nome" maxlength="60" placeholder="Ex.: Caio"></label>
  <label class="f">Celular com DDD<input id="nf-tel" type="tel" inputmode="numeric" placeholder="11 98765-4321"></label></div>
  <button class="primary" data-act="nf-save">Adicionar à equipe</button>
  <p class="note">Depois mande o link do site para a pessoa. Ela entra digitando o celular e já cai direto na lista dela.</p></div>`;
  h += `<p class="h3" style="margin-top:18px">Equipe (${fs.length})</p><div class="team" style="margin-top:8px">`;
  if (!fs.length) h += `<p class="note">Ninguém cadastrado ainda.</p>`;
  for (const f of fs) {
    if (S.ed === "func:" + f.id) { h += `<div class="p" style="flex-wrap:wrap"><input id="ef-nome" value="${esc(f.nome)}" maxlength="60" data-autofocus style="flex:1 1 140px"><input id="ef-tel" type="tel" inputmode="numeric" value="${esc(fmtTel(f.telefone))}" style="flex:1 1 140px"><button class="primary" data-act="ef-save" data-id="${f.id}">Salvar</button><button data-act="cancel">✕</button></div>`; continue; }
    const n = S.d.pessoas.filter(p => p.func_id === f.id && !p.fim).length;
    h += `<div class="p"><span>${esc(f.nome)}<br><small class="note">${esc(fmtTel(f.telefone)) || "sem celular"} · ${n} em aberto</small></span>${f.telefone ? `<a class="zap" href="https://wa.me/55${f.telefone}?text=${encodeURIComponent("Olá " + f.nome + ", este é o app de tarefas da decoração de Natal: " + location.origin + " . Entre digitando o seu celular.")}" target="_blank" rel="noopener">Enviar link</a>` : ""}<button class="ghost" data-act="ef" data-id="${f.id}">Editar</button>${confirmBtn("del-func", f.id, "Remover")}</div>`;
  }
  return h + `</div><div class="panel" style="margin-top:18px"><p class="h3">Link para mandar à equipe</p><p style="margin:0;font-weight:600;overflow-wrap:anywhere">${esc(location.origin)}</p>
  <div class="row"><button data-act="copiar">Copiar link</button><a class="zap" href="https://wa.me/?text=${encodeURIComponent("Tarefas da decoração de Natal: " + location.origin)}" target="_blank" rel="noopener">Enviar no WhatsApp</a></div></div>`;
}

/* ---------- editar (gestor) ---------- */
function formEditar(t) {
  const E = S.ed;
  return `<div class="panel"><p class="h3">Editar tarefa</p>
  <div class="names small">${S.d.funcionarios.map(f => `<button data-act="ed-pessoa" data-id="${f.id}" class="${E.pessoas.has(f.id) ? "on" : ""}" aria-pressed="${E.pessoas.has(f.id)}">${E.pessoas.has(f.id) ? "✔ " : ""}${esc(f.nome)}</button>`).join("")}</div>
  <label class="f">Entregar até<input id="ed-prazo" type="datetime-local" value="${esc(t.prazo && !t.prazo.includes("T") ? t.prazo + "T18:00" : t.prazo || "")}"></label>
  <div class="prio-btns">${Object.entries(PRIO).map(([k, p]) => `<button class="p-${k} ${E.prioridade === k ? "on" : ""}" data-act="ed-prio" data-k="${k}">${p.i} ${p.l}</button>`).join("")}</div>
  <label class="f">Título<input id="ed-titulo" maxlength="200" value="${esc(t.descricao)}"></label>
  <label class="f">Detalhes<textarea id="ed-det" maxlength="1000">${esc(t.detalhes || "")}</textarea></label>
  <p class="note">Quem você tirar da tarefa perde o registro de ciente, início e fim dela.</p>
  <div class="row"><button class="primary" data-act="ed-save" data-id="${t.id}">Salvar</button><button data-act="cancel">Cancelar</button></div></div>`;
}

/* ---------- cartão da tarefa ---------- */
function fotoFim(p, t) {
  const f = (S.d.anexos || []).filter(x => x.tarefa_id === t.id && x.autor_id === p.func_id && x.conclusao).pop();
  if (!f) return ""; const url = `/api/anexos/${f.id}?k=${encodeURIComponent(S.chave)}`;
  return `<a class="foto-fim" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Foto do trabalho pronto de ${esc(nome(p.func_id))}" loading="lazy"></a>`;
}
function situacao(p, t) {
  if (p.fim) return `<span class="ok-txt">✔ Terminou ${fmtDT(p.fim)}</span>${fotoFim(p, t)}`;
  if (p.inicio) return `<span class="run-txt">▶ Iniciou ${fmtDT(p.inicio)}</span>`;
  if (p.ciente) return `<span>👁 Ciente ${fmtDT(p.ciente)}</span>`;
  return `<span class="late-txt">Ainda não abriu</span>`;
}
function card(t) {
  if (S.ed && S.ed.id === t.id) return formEditar(t);
  const e = estado(t), open = S.open.has(t.id), m = !G() && minha(t), ps = pessoasDe(t), pr = prio(t);
  const pill = { pend: ["", "A iniciar"], run: ["run", "Em andamento"], ok: ["ok", "Concluída"], late: ["late", "Atrasada"], "late-run": ["late", "Atrasada · em andamento"] }[e];
  const obs = S.d.obs.filter(o => o.tarefa_id === t.id), anx = (S.d.anexos || []).filter(x => x.tarefa_id === t.id);
  const cientes = ps.filter(p => p.ciente || p.inicio || p.fim).length, setor = setorNome(t);
  const outros = m ? ps.filter(p => p.func_id !== EU()) : ps;
  let h = `<article class="task p-${pr} ${open ? "open" : ""}"><div class="task-h" data-act="toggle" data-id="${t.id}" role="button" aria-expanded="${open}">
  <div class="t"><div class="d">${esc(t.descricao)}</div><div class="meta"><span class="prio-txt p-${pr}">${PRIO[pr].i} ${PRIO[pr].l}</span>
  <span class="${e.startsWith("late") ? "late-txt" : ""}">📅 ${fmtD(t.prazo)}</span>
  <span>${ps.length > 1 ? "👥" : "👤"} ${m ? (outros.length ? "Você + " + esc(outros.map(p => nome(p.func_id)).join(", ")) : "Só você") : esc(ps.map(p => nome(p.func_id)).join(", ") || "Ninguém")}</span>
  ${G() && e !== "ok" && ps.length ? `<span class="${cientes < ps.length ? "late-txt" : "ok-txt"}">👁 ${cientes}/${ps.length} ciente${ps.length === 1 ? "" : "s"}</span>` : ""}
  ${m && !m.ciente ? `<span class="late-txt">● Nova · toque para abrir</span>` : ""}
  ${obs.length ? `<span>💬 ${obs.length}</span>` : ""}${anx.length ? `<span>📎 ${anx.length}</span>` : ""}${setor ? `<span>📍 ${esc(setor)}</span>` : ""}</div></div>
  <span class="pill ${pill[0]}">${pill[1]}</span><span class="chev" aria-hidden="true">›</span></div>`;
  if (!open) return h + `</article>`;
  h += `<div class="task-b">`;
  if (t.detalhes) h += `<p class="det">${esc(t.detalhes)}</p>`;
  if (m) {
    if (!m.inicio) h += `<div class="row"><button class="primary big" data-act="iniciar" data-id="${t.id}">▶ INICIAR TAREFA</button></div><p class="note">Aperte só na hora que for começar o trabalho de verdade.</p>`;
    else if (!m.fim) h += `<div class="row"><button class="primary big stop" data-act="terminar" data-id="${t.id}">📸 TERMINAR TAREFA</button></div><p class="note">Você iniciou ${fmtDT(m.inicio)}. Quando acabar, aperte e tire uma foto do trabalho pronto.</p>`;
    else h += `<p class="ok-txt">✔ Você terminou ${fmtDT(m.fim)}.</p>`;
  }
  h += `<p class="h3">${ps.length > 1 ? "Quem está na tarefa" : "Responsável"}</p><div class="quem">`;
  for (const p of ps) {
    h += `<div class="q"><b>${esc(nome(p.func_id))}${m && p.func_id === EU() ? " (você)" : ""}</b>${situacao(p, t)}`;
    if (G()) {
      const acts = [];
      if (!p.fim) { const l = zap(p.func_id, msgNova(p.func_id, t)); if (l) acts.push(`<a class="zap sm" href="${l}" target="_blank" rel="noopener">📲 Avisar</a>`); }
      if (p.inicio || p.fim) acts.push(confirmBtn("zerar", t.id + "-" + p.func_id, "Zerar início/fim"));
      if (acts.length) h += `<div class="row">${acts.join("")}</div>`;
    }
    h += `</div>`;
  }
  h += `</div><p class="note">Criada ${fmtDT(t.criado)} pelo gestor.</p>`;
  h += `<p class="h3">Anexos</p><div class="anexos">`;
  for (const x of anx) {
    const url = `/api/anexos/${x.id}?k=${encodeURIComponent(S.chave)}`;
    h += `<div class="anx">${x.tipo.startsWith("image/") ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(x.nome)}" loading="lazy"></a>`
      : `<a class="pdf" href="${url}" target="_blank" rel="noopener">📄 ${esc(x.nome)}</a>`}${x.autor_id ? `<small class="note">${x.conclusao ? "📸 pronto · " : ""}por ${esc(nome(x.autor_id))}</small>` : ""}${G() ? confirmBtn("del-anx", x.id, "Apagar") : ""}</div>`;
  }
  if (!anx.length) h += `<p class="note">Nenhum arquivo.</p>`;
  h += `</div><label class="upl"><input type="file" accept="${ACEITA}" multiple data-upl="${t.id}" hidden>📎 Anexar arquivo</label>`;
  h += `<p class="h3">Observações</p><div class="obs-list">`;
  if (!obs.length) h += `<p class="note">Sem observações.</p>`;
  for (const o of obs) {
    if (o.gestor) { h += `<div class="obs g"><div class="who"><b>Gestor</b> · ${fmtDT(o.em)}</div><p>${esc(o.texto)}</p></div>`; continue; }
    const meu = !G() && o.autor_id === EU();
    if (S.editingObs === o.id) { h += `<div class="obs"><textarea id="eo-txt" maxlength="1000" data-autofocus>${esc(o.texto)}</textarea><div class="acts"><button class="primary" data-act="eo-save" data-id="${o.id}">Salvar</button><button data-act="cancel">Cancelar</button></div></div>`; continue; }
    h += `<div class="obs"><div class="who"><b>${esc(nome(o.autor_id))}</b> · ${fmtDT(o.em)}${o.editado ? " · corrigida" : ""}</div><p>${esc(o.texto)}</p>`;
    const acts = [];
    if (meu) acts.push(`<button class="ghost" data-act="eo" data-id="${o.id}">Corrigir</button>`);
    if (meu || G()) acts.push(confirmBtn("del-obs", o.id, "Apagar"));
    if (acts.length) h += `<div class="acts">${acts.join("")}</div>`;
    h += `</div>`;
  }
  h += `</div><textarea id="ob-${t.id}" maxlength="1000" placeholder="${G() ? "Observação do gestor (ninguém apaga)" : "Escreva uma observação"}"></textarea><button class="primary" data-act="ob" data-id="${t.id}">Enviar observação</button>`;
  if (G()) h += `<div class="row"><button data-act="et" data-id="${t.id}">Editar</button>${confirmBtn("del-task", t.id, "Excluir")}</div>`;
  return h + `</div></article>`;
}

/* ---------- alertas de atraso (gestor) ---------- */
function alertas() {
  const daqui = new Date(Date.now() + 2 * 3600e3).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16).replace(" ", "T");
  const abertas = S.d.tarefas.filter(aberta);
  const vencidas = abertas.filter(t => atrasado(t.prazo)).sort(ordenar);
  const semInicio = abertas.filter(t => !atrasado(t.prazo) && t.prazo && t.prazo.includes("T") && t.prazo <= daqui && pessoasDe(t).some(p => !p.inicio)).sort(ordenar);
  if (!vencidas.length && !semInicio.length) return "";
  if (S.tab === "nova") return `<button class="alerta curto" data-act="ver-alertas"><b class="al-t">🚨 ${[vencidas.length ? (vencidas.length === 1 ? "1 atrasada" : vencidas.length + " atrasadas") : "", semInicio.length ? semInicio.length + " vencendo sem iniciar" : ""].filter(Boolean).join(" · ")}</b><small>Toque para ver</small></button>`;
  const linha = (t, txt) => `<button class="al-item" data-act="ir-tarefa" data-id="${t.id}"><span>${PRIO[prio(t)].i} <b>${esc(t.descricao)}</b></span><small>${txt}</small></button>`;
  let h = `<div class="alerta" role="alert"><b class="al-t">🚨 Atenção</b>`;
  if (vencidas.length) {
    h += `<p class="h3">${vencidas.length === 1 ? "1 tarefa atrasada" : vencidas.length + " tarefas atrasadas"}</p>`;
    vencidas.slice(0, 6).forEach(t => h += linha(t, `venceu ${fmtD(t.prazo)} · falta: ${esc(pessoasDe(t).filter(p => !p.fim).map(p => nome(p.func_id) + (p.inicio ? "" : " (não iniciou)")).join(", "))}`));
  }
  if (semInicio.length) {
    h += `<p class="h3">Vence em até 2 horas e ainda não iniciou</p>`;
    semInicio.slice(0, 6).forEach(t => h += linha(t, `entrega ${fmtD(t.prazo)} · ${esc(pessoasDe(t).filter(p => !p.inicio).map(p => nome(p.func_id)).join(", "))}`));
  }
  return h + `</div>`;
}

/* ---------- avisos no celular ---------- */
const temPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const chavePush = () => "push_" + (G() ? "gestor" : EU());
function botaoPush() {
  if (temPush() && Notification.permission === "granted" && ls.get(chavePush())) return "";
  if (temPush() && Notification.permission === "denied") return `<p class="note push-n">🔕 Os avisos no celular estão bloqueados. Para ligar, libere as notificações deste site nas configurações do navegador.</p>`;
  if (!temPush()) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return ios ? `<p class="note push-n">🔔 No iPhone, para receber avisos: toque em Compartilhar e depois em <b>Adicionar à Tela de Início</b>, e abra o app por lá.</p>` : "";
  }
  return `<div class="push"><span>🔔 Receba as tarefas novas${G() ? " e quem terminou" : " e o aviso de prazo"} direto no celular.</span><button class="primary" data-act="push">Ativar avisos</button></div>`;
}
function b64(s) { const p = "=".repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, c => c.charCodeAt(0)); }
async function assinarPush(teste) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) { const { chave } = await api("GET", "/api/push/chave"); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(chave) }); }
  await api("POST", "/api/push/assinar", sub.toJSON());
  ls.set(chavePush(), "1");
  if (teste) await api("POST", "/api/push/teste");
}
async function ativarPush(b) {
  b.disabled = true; b.textContent = "Ativando…";
  try {
    if (await Notification.requestPermission() !== "granted") throw new Error("Você não permitiu os avisos. Dá para liberar depois nas configurações do navegador.");
    await assinarPush(true); S.err = "";
  } catch (e) { S.err = e.message || "Não consegui ligar os avisos neste celular."; }
  draw();
}
let pushOk = false;
function renovarPush() { if (pushOk || !S.d || !temPush() || Notification.permission !== "granted") return; pushOk = true; assinarPush(false).catch(() => {}); }

/* ---------- ações ---------- */
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
async function acao(method, url, body) {
  if (S.busy) return; S.busy = true;
  try { S.err = ""; await api(method, url, body); await carregar(); }
  catch (e) { S.err = e.message; draw(); }
  finally { S.busy = false; }
}
function marcarCiente(id) {
  const t = S.d.tarefas.find(x => x.id === id), m = t && minha(t);
  if (!m || m.ciente) return;
  m.ciente = Date.now(); // mostra na hora; o servidor confirma
  api("POST", `/api/tarefas/${id}/ciente`).then(carregar).catch(e => { S.err = e.message; draw(); });
}
async function enviarArquivos(id, files) {
  for (const f0 of files) {
    const f = await reduzir(f0);
    if (f.size > 12 * 1024 * 1024) throw new Error(`"${f0.name}" passa de 12 MB.`);
    const r = await fetch(`/api/tarefas/${id}/anexos`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream", "x-chave": S.chave, "x-nome": encodeURIComponent(f.name) }, body: f });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || "Falha ao enviar o arquivo.");
  }
}
function guardarWz() {
  const W = S.wz;
  [["wz-prazo", "prazo"], ["wz-titulo", "titulo"], ["wz-det", "detalhes"]].forEach(([id, k]) => { const el = document.getElementById(id); if (el) W[k] = el.value.trim(); });
  const sv = document.getElementById("wz-salvar"); if (sv) W.salvarModelo = sv.checked;
}
document.addEventListener("input", ev => { if (ev.target.id && ev.target.id.startsWith("wz-") && ev.target.type !== "file") guardarWz(); });

document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id ? Number(b.dataset.id) : null;
  if (act !== "ask") S.confirm = null;
  switch (act) {
    case "ver-novas": { const n = novas(); marcarVistas(n.map(t => t.id)); S.fStatus = "abertas"; S.fPrio = "todas"; n.forEach(t => { S.open.add(t.id); marcarCiente(t.id); }); return draw(); }
    case "topo": window.scrollTo({ top: 0, behavior: "smooth" }); return;
    case "lembrete-ok": S.lembreteVisto = true; return draw();
    case "push": return ativarPush(b);
    case "tab": S.tab = b.dataset.k; S.ed = null; if (S.tab === "nova" && S.wz.criada) S.wz = novoWz(); return draw();
    case "fprio": S.fPrio = b.dataset.k; return draw();
    case "fstatus": S.fStatus = b.dataset.k; return draw();
    case "toggle": if (S.open.has(id)) S.open.delete(id); else { S.open.add(id); if (!G()) { marcarVistas([id]); marcarCiente(id); } } return draw();
    case "cancel": S.ed = S.editingObs = null; return draw();
    case "ask": { const k = b.dataset.k + ":" + b.dataset.id; S.confirm = k; draw(); setTimeout(() => { if (S.confirm === k) { S.confirm = null; draw(); } }, 4000); return; }
    case "sair": S.chave = null; ls.set("chave", null); S.d = null; S.tab = null; S.entrarGestor = false; S.lembreteVisto = false; S.wz = novoWz(); pushOk = false; return draw();
    case "ir-gestor": S.entrarGestor = true; return draw();
    case "voltar": S.entrarGestor = false; return draw();
    case "login-g": try { const r = await api("POST", "/api/gestor", { senha: val("senha") }); S.chave = r.chave; ls.set("chave", r.chave); S.err = ""; S.entrarGestor = false; carregar(); } catch (e) { S.err = e.message; draw(); } return;
    case "login-f": try { const r = await api("POST", "/api/entrar", { telefone: val("tel") }); S.chave = r.chave; ls.set("chave", r.chave); S.err = ""; carregar(); } catch (e) { S.err = e.message; draw(); } return;
    // passo a passo
    case "wz-pessoa": S.wz.pessoas.has(id) ? S.wz.pessoas.delete(id) : S.wz.pessoas.add(id); return draw();
    case "wz-todos": { const all = S.d.funcionarios.map(f => f.id); S.wz.pessoas = S.wz.pessoas.size === all.length ? new Set() : new Set(all); return draw(); }
    case "wz-rapido": S.wz.prazo = b.dataset.k; { const el = document.getElementById("wz-prazo"); if (el) el.value = b.dataset.k; } return draw();
    case "wz-modelo": { const m = (S.d.modelos || []).find(x => x.id === id); if (!m) return;
      S.wz = Object.assign(novoWz(), { pessoas: new Set(m.pessoas.filter(i => S.d.funcionarios.some(f => f.id === i))), prioridade: PRIO[m.prioridade] ? m.prioridade : "normal", titulo: m.titulo, detalhes: m.detalhes || "", modelo: m.titulo });
      S.wz.passo = S.wz.pessoas.size ? 2 : 1; draw(); window.scrollTo({ top: 0 }); return; }
    case "ver-alertas": S.tab = "acompanhar"; draw(); window.scrollTo({ top: 0 }); return;
    case "del-modelo": return acao("DELETE", "/api/modelos/" + id);
    case "ir-tarefa": S.tab = "acompanhar"; S.fStatus = "todas"; S.fPrio = "todas"; S.fPessoa = ""; S.open.add(id); draw();
      { const el = document.querySelector(`[data-act="toggle"][data-id="${id}"]`); if (el) el.scrollIntoView({ block: "center" }); } return;
    case "wz-ir": { guardarWz(); const p = Number(b.dataset.k); if (S.wz.passo === 2 && p === 3) S.wz.passoAntes = 2;
      if (p === 3 && !S.wz.prazo) { S.err = "Escolha a data e a hora da entrega."; return draw(); }
      S.err = ""; S.wz.passo = p === 3 && S.wz.modelo && S.wz.passoAntes === 2 ? 4 : p; S.wz.passoAntes = null; draw(); window.scrollTo({ top: 0 }); return; }
    case "wz-prio": S.wz.prioridade = b.dataset.k; S.wz.passo = 4; S.err = ""; draw(); window.scrollTo({ top: 0 }); return;
    case "wz-tira": S.wz.arquivos.splice(id, 1); return draw();
    case "wz-outra": S.wz = novoWz(); return draw();
    case "wz-criar": { guardarWz(); const W = S.wz;
      if (!W.titulo) { S.err = "Escreva o título da tarefa."; draw(); const el = document.getElementById("wz-titulo"); if (el) el.focus(); return; }
      if (S.busy) return; S.busy = true; S.err = ""; b.disabled = true; b.textContent = "Criando…";
      try {
        const r = await api("POST", "/api/tarefas", { pessoas: [...W.pessoas], prazo: W.prazo, prioridade: W.prioridade, titulo: W.titulo, detalhes: W.detalhes, salvarModelo: !W.modelo && !!W.salvarModelo });
        try { await enviarArquivos(r.id, W.arquivos); } catch (e) { S.err = "Tarefa criada, mas um anexo falhou: " + e.message; }
        S.wz = novoWz(); S.wz.criada = r.id;
      } catch (e) { S.err = e.message; }
      S.busy = false; await carregar(); window.scrollTo({ top: 0 }); return; }
    // editar
    case "et": { const t = S.d.tarefas.find(x => x.id === id); S.ed = { id, pessoas: new Set(pessoasDe(t).map(p => p.func_id)), prioridade: prio(t) }; return draw(); }
    case "ed-pessoa": S.ed.pessoas.has(id) ? S.ed.pessoas.delete(id) : S.ed.pessoas.add(id); return draw();
    case "ed-prio": S.ed.prioridade = b.dataset.k; return draw();
    case "ed-save": { const body = { pessoas: [...S.ed.pessoas], prioridade: S.ed.prioridade, prazo: val("ed-prazo"), titulo: val("ed-titulo"), detalhes: val("ed-det") };
      try { S.busy = true; await api("PATCH", "/api/tarefas/" + id, body); S.ed = null; S.err = ""; } catch (e) { S.err = e.message; }
      S.busy = false; return carregar(); }
    case "del-task": S.open.delete(id); return acao("DELETE", "/api/tarefas/" + id);
    case "iniciar": return acao("POST", `/api/tarefas/${id}/iniciar`);
    case "terminar": { S.terminando = id; const inp = document.getElementById("foto-fim"); inp.value = ""; inp.click(); return; }
    case "zerar": { const [tid, fid] = b.dataset.id.split("-"); return acao("POST", `/api/tarefas/${tid}/zerar/${fid}`); }
    case "ob": { const el = document.getElementById("ob-" + id); const t = el ? el.value.trim() : ""; if (!t) return; el.value = ""; el.blur(); return acao("POST", `/api/tarefas/${id}/obs`, { texto: t }); }
    case "eo": S.editingObs = id; return draw();
    case "eo-save": { const t = val("eo-txt"); if (!t) return; S.editingObs = null; return acao("PATCH", "/api/obs/" + id, { texto: t }); }
    case "del-anx": return acao("DELETE", "/api/anexos/" + id);
    case "del-obs": return acao("DELETE", "/api/obs/" + id);
    case "nf-save": { const n = val("nf-nome"), t = val("nf-tel"); if (!n || !t) { S.err = !n ? "Digite o nome do colaborador." : "Digite o celular com DDD."; draw(); return; }
      await acao("POST", "/api/funcionarios", { nome: n, telefone: t }); if (!S.err) { const a = document.getElementById("nf-nome"), b2 = document.getElementById("nf-tel"); if (a) a.value = ""; if (b2) b2.value = ""; } return; }
    case "ef": S.ed = "func:" + id; return draw();
    case "ef-save": { const n = val("ef-nome"); if (!n) return; S.ed = null; return acao("PATCH", "/api/funcionarios/" + id, { nome: n, telefone: val("ef-tel") }); }
    case "del-func": return acao("DELETE", "/api/funcionarios/" + id);
    case "copiar": try { await navigator.clipboard.writeText(location.origin); b.textContent = "Copiado!"; } catch (e) { b.textContent = location.origin; } return;
  }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "senha") document.querySelector('[data-act="login-g"]').click();
  if (e.key === "Enter" && e.target.id === "tel") document.querySelector('[data-act="login-f"]').click(); });

/* ---------- anexos ---------- */
function tipoDe(f) {
  if (f.type) return f.type === "image/jpg" ? "image/jpeg" : f.type;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain" }[ext] || "";
}
function reduzir(file0) {
  const tipo = tipoDe(file0), file = tipo === file0.type ? file0 : new File([file0], file0.name, { type: tipo });
  return new Promise(res => {
    if (!tipo.startsWith("image/")) return res(file);
    const nativo = /^image\/(jpeg|png|webp)$/.test(tipo);
    if (nativo && file.size < 600 * 1024) return res(file);
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => { const max = 2000, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
      c.toBlob(b => res(b && (!nativo || b.size < file.size) ? new File([b], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file), "image/jpeg", 0.82); };
    img.onerror = () => { URL.revokeObjectURL(u); res(file); };
    img.src = u;
  });
}
document.addEventListener("change", async ev => {
  if (ev.target.id === "f-pessoa") { S.fPessoa = ev.target.value; return draw(); }
  if (ev.target.id === "foto-fim") {
    const f0 = ev.target.files[0], id = S.terminando; ev.target.value = ""; if (!f0 || !id) return;
    S.busy = true; S.err = ""; S.enviandoFoto = id; draw();
    try {
      const f = await reduzir(f0);
      if (!f.type.startsWith("image/") || f.type === "image/heic" || f.type === "image/heif") throw new Error("Não consegui ler essa foto. Tire a foto pela câmera do app ou envie em JPG.");
      const r = await fetch(`/api/tarefas/${id}/anexos`, { method: "POST", headers: { "content-type": f.type, "x-chave": S.chave, "x-nome": encodeURIComponent("pronto-" + f.name), "x-conclusao": "1" }, body: f });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || "Falha ao enviar a foto.");
      await api("POST", `/api/tarefas/${id}/terminar`);
    } catch (e) { S.err = e.message; }
    S.busy = false; S.enviandoFoto = null; S.terminando = null; return carregar();
  }
  if (ev.target.id === "wz-arq") { guardarWz(); S.wz.arquivos.push(...ev.target.files); ev.target.value = ""; return draw(); }
  const inp = ev.target.closest("input[data-upl]"); if (!inp || !inp.files.length) return;
  const id = inp.dataset.upl, files = [...inp.files]; inp.value = "";
  S.busy = true; S.err = ""; const lbl = inp.parentElement; if (lbl) lbl.textContent = "Enviando…";
  try { await enviarArquivos(id, files); } catch (e) { S.err = e.message; }
  S.busy = false; carregar();
});

/* ---------- atualização automática ---------- */
setInterval(() => { if (S.chave && !document.hidden && !S.busy) carregar(); }, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { S.escondidoEm = Date.now(); return; }
  // Voltou ao app depois de um tempo: mostra o lembrete de novo
  if (S.escondidoEm && Date.now() - S.escondidoEm > 20 * 60 * 1000) S.lembreteVisto = false;
  carregar();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (S.chave) carregar();
draw();
})();
