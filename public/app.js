(function () {
"use strict";
const TZ = "America/Sao_Paulo";
const app = document.getElementById("app");
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };

const novoWz = () => ({ passo: 1, pessoas: new Set(), prazo: "", prioridade: "", titulo: "", detalhes: "", local: "", arquivos: [], criada: null });
const S = { chave: ls.get("chave"), d: null, tab: null, open: new Set(), err: "", busy: false, entrarGestor: false, confirm: null,
  ed: null, editingObs: null, wz: novoWz(), fPrio: "todas", fStatus: "abertas", fPessoa: "", fLocal: "", lembreteVisto: false, escondidoEm: 0 };

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
// Local da tarefa (onde é o serviço). Tarefas antigas usam o nome do setor.
const localDe = t => String(t.local || setorNome(t) || "").trim();
const chaveLocal = l => String(l).toLocaleLowerCase("pt-BR");
function listaLocais() { const m = new Map(); S.d.tarefas.forEach(t => { const l = localDe(t); if (l && !m.has(chaveLocal(l))) m.set(chaveLocal(l), l); });
  return [...m.values()].sort((a, b) => a.localeCompare(b, "pt-BR")); }
const SEM_LOCAL = "__sem";
const okLocal = t => !S.fLocal || (S.fLocal === SEM_LOCAL ? !localDe(t) : chaveLocal(localDe(t)) === chaveLocal(S.fLocal));
const okPessoa = t => !S.fPessoa || S.d.pessoas.some(p => p.tarefa_id === t.id && String(p.func_id) === S.fPessoa);
// Filtros de local e pessoa (os mesmos no Painel e no Acompanhar)
function filtrosLP() {
  const ls = listaLocais();
  if (S.fLocal && S.fLocal !== SEM_LOCAL && !ls.some(l => chaveLocal(l) === chaveLocal(S.fLocal))) S.fLocal = "";
  const temSem = S.d.tarefas.some(t => !localDe(t));
  return `<div class="filtros-lp"><label class="f">📍 Local<select id="f-local"><option value="">Todos</option>${ls.map(l => `<option value="${esc(l)}" ${chaveLocal(l) === chaveLocal(S.fLocal) ? "selected" : ""}>${esc(l)}</option>`).join("")}${temSem ? `<option value="${SEM_LOCAL}" ${S.fLocal === SEM_LOCAL ? "selected" : ""}>Sem local</option>` : ""}</select></label>
    <label class="f">👤 Pessoa<select id="f-pessoa"><option value="">Todas</option>${S.d.funcionarios.map(f => `<option value="${f.id}" ${String(f.id) === S.fPessoa ? "selected" : ""}>${esc(f.nome)}</option>`).join("")}</select></label></div>
    ${S.fLocal || S.fPessoa ? `<div class="row" style="margin-top:6px"><span class="note">Mostrando só ${[S.fLocal ? (S.fLocal === SEM_LOCAL ? "tarefas sem local" : "o local " + esc(S.fLocal)) : "", S.fPessoa ? "as tarefas de " + esc(nome(Number(S.fPessoa))) : ""].filter(Boolean).join(" e ")}.</span><button class="ghost" data-act="limpar-filtros">✕ Limpar filtros</button></div>` : ""}`;
}
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
const ativas = () => S.d.tarefas.filter(t => !t.arquivada);
const ordenar = (a, b) => (PRIO[prio(a)].r - PRIO[prio(b)].r) || (a.prazo || "9999").localeCompare(b.prazo || "9999") || a.id - b.id;

function vistas() { try { return new Set(JSON.parse(ls.get("vistas_" + EU()) || "[]")); } catch (e) { return new Set(); } }
function marcarVistas(ids) { const v = vistas(); ids.forEach(i => v.add(i)); ls.set("vistas_" + EU(), JSON.stringify([...v])); }
function novas() {
  if (!S.d || G() || S.d.eu.seguranca) return [];
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
// Recarrega o app sozinho quando sai uma versão nova (sem atrapalhar quem está tirando foto ou digitando)
let versaoApp = null;
async function checarVersao() {
  try {
    const { v } = await (await fetch("/versao", { cache: "no-store" })).json();
    if (!versaoApp) { versaoApp = v; return; }
    const ocupado = S.busy || document.getElementById("camera") || document.getElementById("visor") || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
    if (v !== versaoApp && !ocupado) location.reload();
  } catch (e) {}
}
checarVersao(); setInterval(checarVersao, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checarVersao(); });
async function carregar() {
  if (!S.chave) return;
  try { S.d = await api("GET", "/api/estado"); if (S.err.startsWith("Sem conexão")) S.err = ""; avisar(); renovarPush(); checarAlarme(); }
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

let ultimoHtml = null;
function drawInner() {
  const role = document.getElementById("role"), stats = document.getElementById("stats");
  let h = S.err ? `<div class="banner">${esc(S.err)}</div>` : "";
  if (S.enviandoFoto) h += `<div class="aviso"><b>📸 Enviando a foto e terminando a tarefa…</b></div>`;
  if (!S.chave || !S.d) {
    role.hidden = true; stats.innerHTML = ""; ultimoHtml = null;
    if (S.chave && !S.d) { app.innerHTML = h + `<div class="empty">Carregando…</div>`; return; }
    app.innerHTML = h + entrada(); const f = app.querySelector("[data-autofocus]"); if (f) f.focus(); return;
  }
  role.hidden = false; role.textContent = (G() ? S.d.eu.nome || "Gestor" : S.d.eu.nome) + " · Sair";
  if (!G() && S.d.eu.seguranca) { stats.innerHTML = `<span>🛡 Segurança · turno ${S.d.eu.turno === "noite" ? "da noite" : "do dia"} ${esc(S.d.eu.turno_ini || "")}–${esc(S.d.eu.turno_fim || "")}</span>`;
    { const x = h + statusPanico() + segGuarda() + barraPanico(); if (ultimoHtml !== x) { app.innerHTML = x; ultimoHtml = x; } } checarSirene(); return; }
  h += avisoPanico();
  const ts = ativas(), c = { pend: 0, run: 0, ok: 0, late: 0 };
  ts.forEach(t => { const e = estado(t); if (e === "ok") c.ok++; else if (e === "run" || e === "late-run") c.run++; else c.pend++; if (e.startsWith("late")) c.late++; });
  stats.innerHTML = `<span>${c.pend} a iniciar</span><span>${c.run} em andamento</span><span>${c.ok} concluídas</span>${c.late ? `<span>${c.late} atrasadas</span>` : ""}`;

  if (G()) {
    const tabs = [["nova", "＋ Nova tarefa"], ["painel", "📊 Painel"], ["acompanhar", "Acompanhar"], ["equipe", "Equipe"], ["seg", "🛡 Segurança"]];
    if (!S.tab || !tabs.some(x => x[0] === S.tab)) S.tab = "nova";
    h += `<nav class="tabs">${tabs.map(([k, l]) => chip("tab", k, S.tab === k, l)).join("")}</nav>`;
    if (S.tab !== "equipe" && S.tab !== "seg") h += alertas();
    h += botaoPush();
    h += S.tab === "nova" ? wizard() : S.tab === "equipe" ? equipe() : S.tab === "seg" ? segGestor() : S.tab === "painel" ? painel() : acompanhar();
  } else if (S.d.eu.panico) {
    if (S.tab !== "seg") S.tab = "tarefas";
    h += `<nav class="tabs">${chip("tab", "tarefas", S.tab === "tarefas", "Minhas tarefas")}${chip("tab", "seg", S.tab === "seg", "🛡 Seguranças")}</nav>`;
    h += S.tab === "seg" ? botaoPush() + segGestor(true) : colaborador();
  } else h += colaborador();
  if (ultimoHtml !== h) { app.innerHTML = h; ultimoHtml = h; } checarSirene();
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
    <label class="f">📍 Local (opcional)<input id="wz-local" maxlength="80" list="locais-dl" value="${esc(W.local)}" placeholder="Ex.: Praça, Coreto, Av. dos Autonomistas"></label>${datalistLocais()}
    <label class="f">Detalhes (opcional)<textarea id="wz-det" maxlength="1000" placeholder="Local, material, observações…">${esc(W.detalhes)}</textarea></label>
    <p class="h3">Anexos</p>${W.arquivos.length ? `<div class="arqs">${W.arquivos.map((f, i) => `<span class="pill">📎 ${esc(f.name)} <button class="ghost" data-act="wz-tira" data-id="${i}" aria-label="Tirar ${esc(f.name)}">✕</button></span>`).join("")}</div>` : ""}
    <label class="upl"><input type="file" id="wz-arq" accept="${ACEITA}" multiple hidden>📎 Anexar arquivo (foto, PDF, Word, Excel)</label>
    ${W.modelo ? `<p class="note">⚡ Usando o modelo “${esc(W.modelo)}”.</p>` : `<label class="check"><input type="checkbox" id="wz-salvar" ${W.salvarModelo ? "checked" : ""}> Salvar como modelo para usar de novo</label>`}</div>`;
  return h + `<div class="wz-nav"><button class="big" data-act="wz-ir" data-k="3">← Voltar</button><button class="primary big" data-act="wz-criar">✔ Criar tarefa</button></div>`;
}
const datalistLocais = () => `<datalist id="locais-dl">${listaLocais().map(l => `<option value="${esc(l)}">`).join("")}</datalist>`;
const ACEITA = "image/*,.jpg,.jpeg,.png,.heic,.pdf,application/pdf,.doc,.docx,.xls,.xlsx,.txt";

/* ---------- gestor: acompanhar ---------- */
function acompanhar() {
  const arq = S.fStatus === "arquivadas", ts = S.d.tarefas.filter(t => arq ? t.arquivada : !t.arquivada);
  let h = `<p class="h3" style="margin-top:12px">Prioridade</p><nav class="tabs prio">${chip("fprio", "todas", S.fPrio === "todas", "Todas")}${Object.entries(PRIO).map(([k, p]) => chip("fprio", k, S.fPrio === k, `${p.i} ${p.l}`)).join("")}</nav>`;
  const st = [["abertas", "Abertas"], ["iniciar", "A iniciar"], ["andamento", "Em andamento"], ["atrasadas", "Atrasadas"], ["concluidas", "Concluídas"], ["todas", "Todas"], ["arquivadas", "🗄 Arquivadas"]];
  if (!st.some(x => x[0] === S.fStatus)) S.fStatus = "abertas";
  h += `<nav class="tabs st" style="padding-top:6px">${st.map(([k, l]) => chip("fstatus", k, S.fStatus === k, l)).join("")}</nav>`;
  h += filtrosLP();
  const okSt = t => { const e = estado(t); switch (S.fStatus) {
    case "abertas": return e !== "ok"; case "iniciar": return e === "pend"; case "andamento": return e === "run" || e === "late-run";
    case "atrasadas": return e === "late" || e === "late-run"; case "concluidas": return e === "ok"; default: return true; } };
  const list = ts.filter(t => okSt(t) && (S.fPrio === "todas" || prio(t) === S.fPrio) && okPessoa(t) && okLocal(t));
  const fimDe = t => Math.max(0, ...pessoasDe(t).map(p => p.fim || 0));
  list.sort(arq ? (a, b) => Number(b.arquivada) - Number(a.arquivada) : S.fStatus === "concluidas" ? (a, b) => fimDe(b) - fimDe(a) : ordenar);
  if (S.fStatus === "concluidas" && list.length) h += `<div class="row" style="margin-top:12px">${confirmBtn("arq-todas", 0, `🗄 Arquivar ${list.length === 1 ? "esta concluída" : "as " + list.length + " concluídas"}`).replace('class="ghost danger"', 'class="arq-btn"')}</div>`;
  if (arq) h += `<p class="note" style="margin-top:12px">Tarefas arquivadas saem do painel e da lista dos colaboradores, mas continuam guardadas aqui com fotos e observações.</p>`;
  if (!ts.length) return h + `<div class="empty">${arq ? "Nenhuma tarefa arquivada." : "Nenhuma tarefa ainda. Use <b>＋ Nova tarefa</b> para criar a primeira."}</div>`;
  if (!list.length) return h + `<div class="empty">Nada neste filtro.</div>`;
  return h + lista(list, S.fPrio === "todas" && S.fStatus !== "concluidas" && !arq);
}

/* ---------- gestor: painel das tarefas agendadas ---------- */
const ROT = { pend: ["A iniciar", ""], run: ["Em andamento", "run"], "late-run": ["Atrasada · em andamento", "late"], late: ["Atrasada", "late"], ok: ["Concluída", "ok"] };
function diaSP(ms) { return new Date(ms).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 10); }
function painel() {
  const todas = ativas(), ts = todas.filter(t => okLocal(t) && okPessoa(t)), hoje = agora().slice(0, 10), amanha = diaSP(Date.now() + 864e5), semana = diaSP(Date.now() + 7 * 864e5);
  if (!todas.length) return `<div class="empty">Nenhuma tarefa agendada ainda. Use <b>＋ Nova tarefa</b> para criar a primeira.</div>`;
  // Com uma pessoa escolhida, a situação mostrada é a dela (não a do grupo todo)
  const est = t => { if (S.fPessoa) { const p = S.d.pessoas.find(x => x.tarefa_id === t.id && String(x.func_id) === S.fPessoa); if (p) return estadoP(p, t); } return estado(t); };
  const c = { late: 0, pend: 0, run: 0, ok: 0 };
  ts.forEach(t => { const e = est(t); c[e === "late-run" ? "late" : e]++; });
  const h0 = filtrosLP();
  if (!ts.length) return h0 + `<div class="empty">Nenhuma tarefa com esse filtro.</div>`;
  const tile = (k, n, l, cls) => `<button class="pn-tile ${cls}" data-act="painel-filtro" data-k="${k}"><b>${n}</b><span>${l}</span></button>`;
  let h = h0 + `<section class="grupo"><div class="grupo-h"><h2>📊 Resumo</h2><span class="cnt">${ts.length} ${ts.length === 1 ? "tarefa" : "tarefas"}</span></div>
    <div class="pn-tiles">${tile("atrasadas", c.late, "Atrasadas", "late")}${tile("iniciar", c.pend, "A iniciar", "")}${tile("andamento", c.run, "Em andamento", "run")}${tile("concluidas", c.ok, "Concluídas", "ok")}</div>
    <p class="note">Toque num número para ver a lista dessas tarefas.</p></section>`;

  // Agenda: tarefas que ainda não terminaram, separadas pela data de entrega
  const abertas = ts.filter(t => est(t) !== "ok").sort((a, b) => (a.prazo || "9999").localeCompare(b.prazo || "9999") || (PRIO[prio(a)].r - PRIO[prio(b)].r));
  const blocos = [["🚨 Atrasadas", t => atrasado(t.prazo)], ["Hoje", t => !atrasado(t.prazo) && t.prazo && t.prazo.slice(0, 10) === hoje],
    ["Amanhã", t => t.prazo && t.prazo.slice(0, 10) === amanha], ["Próximos 7 dias", t => t.prazo && t.prazo.slice(0, 10) > amanha && t.prazo.slice(0, 10) <= semana],
    ["Mais para frente", t => t.prazo && t.prazo.slice(0, 10) > semana], ["Sem data de entrega", t => !t.prazo]];
  const linha = t => { const e = est(t), ps = pessoasDe(t), feitos = ps.filter(p => p.fim).length, lc = localDe(t);
    return `<button class="pn-item" data-act="ir-tarefa" data-id="${t.id}"><span class="pn-l">${PRIO[prio(t)].i} <b>${esc(t.descricao)}</b></span>
      <small>${t.prazo ? "Entrega " + fmtD(t.prazo) : "Sem prazo"}${lc ? " · 📍 " + esc(lc) : ""} · ${esc(ps.map(p => nome(p.func_id)).join(", ") || "ninguém")}${ps.length > 1 ? ` · ${feitos} de ${ps.length} terminaram` : ""}</small>
      <span class="pill ${ROT[e][1]}">${ROT[e][0]}</span></button>`; };
  h += `<section class="grupo"><div class="grupo-h"><h2>📅 Agenda de entregas</h2><span class="cnt">${abertas.length} a fazer</span></div>`;
  if (!abertas.length) h += `<div class="empty">Tudo entregue! Nenhuma tarefa pendente.</div>`;
  let usadas = new Set();
  for (const [titulo, f] of blocos) {
    const l = abertas.filter(t => !usadas.has(t.id) && f(t)); if (!l.length) continue;
    l.forEach(t => usadas.add(t.id));
    h += `<p class="h3 pn-dia">${titulo} <span class="cnt">${l.length}</span></p><div class="pn-lista">${l.map(linha).join("")}</div>`;
  }
  h += `</section>`;

  // Por colaborador: quanto cada um tem para fazer
  const porPessoa = S.d.funcionarios.filter(f => !S.fPessoa || String(f.id) === S.fPessoa).map(f => { const r = { f, pend: 0, run: 0, late: 0, ok: 0, prox: null };
    S.d.pessoas.forEach(p => { if (p.func_id !== f.id) return; const t = ts.find(x => x.id === p.tarefa_id); if (!t) return;
      const e = estadoP(p, t); if (e === "ok") r.ok++; else { if (e.startsWith("late")) r.late++; else if (e === "run") r.run++; else r.pend++;
        if (t.prazo && !atrasado(t.prazo) && (!r.prox || t.prazo < r.prox)) r.prox = t.prazo; } });
    r.total = r.pend + r.run + r.late + r.ok; return r; }).filter(r => r.total).sort((a, b) => b.late - a.late || (b.pend + b.run) - (a.pend + a.run) || a.f.nome.localeCompare(b.f.nome));
  h += `<section class="grupo"><div class="grupo-h"><h2>👥 Por colaborador</h2><span class="cnt">${porPessoa.length}</span></div>`;
  if (!porPessoa.length) h += `<div class="empty">Ninguém com tarefa agendada.</div>`;
  h += `<div class="pn-lista">${porPessoa.map(r => { const pct = v => (100 * v / r.total).toFixed(1) + "%";
    return `<button class="pn-item" data-act="painel-pessoa" data-id="${r.f.id}"><span class="pn-l"><b>${esc(r.f.nome)}</b></span>
      <span class="pn-bar" aria-hidden="true"><i class="late" style="width:${pct(r.late)}"></i><i class="run" style="width:${pct(r.run)}"></i><i class="pend" style="width:${pct(r.pend)}"></i><i class="ok" style="width:${pct(r.ok)}"></i></span>
      <small>${[r.late ? `<span class="late-txt">${r.late} atrasada${r.late > 1 ? "s" : ""}</span>` : "", r.run ? r.run + " em andamento" : "", r.pend ? r.pend + " a iniciar" : "", r.ok ? r.ok + " concluída" + (r.ok > 1 ? "s" : "") : ""].filter(Boolean).join(" · ")}${r.prox ? ` · próxima entrega ${fmtD(r.prox)}` : ""}</small></button>`; }).join("")}</div>`;
  h += `<p class="note pn-leg"><i class="late"></i> atrasada <i class="run"></i> em andamento <i class="pend"></i> a iniciar <i class="ok"></i> concluída</p></section>`;
  // Por local: quanto falta em cada lugar
  if (!S.fLocal) {
    const m = new Map(); ts.forEach(t => { const l = localDe(t) || "", k = chaveLocal(l); if (!m.has(k)) m.set(k, { l, late: 0, run: 0, pend: 0, ok: 0, total: 0 });
      const r = m.get(k), e = est(t); r[e === "late-run" ? "late" : e]++; r.total++; });
    const ls = [...m.values()].sort((a, b) => (!a.l) - (!b.l) || b.late - a.late || (b.total - b.ok) - (a.total - a.ok) || a.l.localeCompare(b.l, "pt-BR"));
    if (ls.some(r => r.l)) {
      h += `<section class="grupo"><div class="grupo-h"><h2>📍 Por local</h2><span class="cnt">${ls.filter(r => r.l).length}</span></div><div class="pn-lista">${ls.map(r => { const pct = v => (100 * v / r.total).toFixed(1) + "%";
        return `<button class="pn-item" data-act="painel-local" data-k="${esc(r.l || SEM_LOCAL)}"><span class="pn-l"><b>${r.l ? esc(r.l) : "Sem local"}</b></span>
        <span class="pn-bar" aria-hidden="true"><i class="late" style="width:${pct(r.late)}"></i><i class="run" style="width:${pct(r.run)}"></i><i class="pend" style="width:${pct(r.pend)}"></i><i class="ok" style="width:${pct(r.ok)}"></i></span>
        <small>${[r.late ? `<span class="late-txt">${r.late} atrasada${r.late > 1 ? "s" : ""}</span>` : "", r.run ? r.run + " em andamento" : "", r.pend ? r.pend + " a iniciar" : "", r.ok ? r.ok + " concluída" + (r.ok > 1 ? "s" : "") : ""].filter(Boolean).join(" · ")}</small></button>`; }).join("")}</div></section>`;
    }
  }
  return h;
}

function equipe() {
  const fs = S.d.funcionarios;
  let h = `<div class="panel"><p class="h3">Novo colaborador</p><div class="grid2"><label class="f">Nome<input id="nf-nome" maxlength="60" placeholder="Ex.: Caio"></label>
  <label class="f">Celular com DDD<input id="nf-tel" type="tel" inputmode="numeric" placeholder="11 98765-4321"></label></div>
  <label class="check"><input type="checkbox" id="nf-gestor"> É gestor(a): cria tarefas e acompanha os seguranças</label>
  <button class="primary" data-act="nf-save">Adicionar à equipe</button>
  <p class="note">Depois mande o link do site para a pessoa. Ela entra digitando o celular e já cai direto na lista dela.</p></div>`;
  h += `<p class="h3" style="margin-top:18px">Equipe (${fs.length})</p><div class="team" style="margin-top:8px">`;
  if (!fs.length) h += `<p class="note">Ninguém cadastrado ainda.</p>`;
  for (const f of fs) {
    if (S.ed === "func:" + f.id) { h += `<div class="p" style="flex-wrap:wrap"><input id="ef-nome" value="${esc(f.nome)}" maxlength="60" data-autofocus style="flex:1 1 140px"><input id="ef-tel" type="tel" inputmode="numeric" value="${esc(fmtTel(f.telefone))}" style="flex:1 1 140px"><button class="primary" data-act="ef-save" data-id="${f.id}">Salvar</button><button data-act="cancel">✕</button></div>`; continue; }
    const n = S.d.pessoas.filter(p => p.func_id === f.id && !p.fim).length;
    h += `<div class="p"><span>${esc(f.nome)}<br><small class="note">${esc(fmtTel(f.telefone)) || "sem celular"} · ${n} em aberto</small></span>${f.telefone ? `<a class="zap" href="https://wa.me/55${f.telefone}?text=${encodeURIComponent("Olá " + f.nome + ", este é o app de tarefas da decoração de Natal: " + location.origin + " . Entre digitando o seu celular.")}" target="_blank" rel="noopener">Enviar link</a>` : ""}<button class="ghost" data-act="ef" data-id="${f.id}">Editar</button>${confirmBtn("del-func", f.id, "Remover")}</div>`;
  }
  const gs = S.d.gestores || [];
  h += `</div><p class="h3" style="margin-top:18px">Gestão que entra pelo celular (${gs.length})</p><div class="team" style="margin-top:8px">`;
  if (!gs.length) h += `<p class="note">Ninguém além de quem entra com senha.</p>`;
  for (const f of gs) h += `<div class="p"><span>👑 ${esc(f.nome)}<br><small class="note">${esc(fmtTel(f.telefone))} · entra digitando o celular</small></span>${f.telefone ? `<a class="zap" href="https://wa.me/55${f.telefone}?text=${encodeURIComponent("Olá " + f.nome + ", você tem acesso de gestão ao app da decoração de Natal: " + location.origin + " . Entre digitando o seu celular.")}" target="_blank" rel="noopener">Enviar link</a>` : ""}${f.id === S.d.eu.gid ? "" : confirmBtn("del-func", f.id, "Tirar acesso")}</div>`;
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
  <label class="f">📍 Local<input id="ed-local" maxlength="80" list="locais-dl" value="${esc(localDe(t))}" placeholder="Ex.: Praça, Coreto"></label>${datalistLocais()}
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
  const cientes = ps.filter(p => p.ciente || p.inicio || p.fim).length, setor = localDe(t);
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
  if (G() && !t.arquivada && e.startsWith("late")) h += `<p class="h3">Mudar o prazo</p>${prazoRapido(t)}`;
  if (G()) h += `<div class="row">${t.arquivada ? `<button data-act="desarquivar" data-id="${t.id}">↩ Voltar para o painel</button>` : `<button class="${e === "ok" ? "arq-btn" : ""}" data-act="arquivar" data-id="${t.id}">🗄 Arquivar</button>`}<button data-act="et" data-id="${t.id}">Editar</button>${confirmBtn("del-task", t.id, "Excluir")}</div>`;
  return h + `</div></article>`;
}

/* ---------- alertas de atraso (gestor) ---------- */
function alertas() {
  const daqui = new Date(Date.now() + 2 * 3600e3).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16).replace(" ", "T");
  const abertas = ativas().filter(aberta);
  const vencidas = abertas.filter(t => atrasado(t.prazo)).sort(ordenar);
  const semInicio = abertas.filter(t => !atrasado(t.prazo) && t.prazo && t.prazo.includes("T") && t.prazo <= daqui && pessoasDe(t).some(p => !p.inicio)).sort(ordenar);
  if (!vencidas.length && !semInicio.length) return "";
  if (S.tab === "nova") return `<button class="alerta curto" data-act="ver-alertas"><b class="al-t">🚨 ${[vencidas.length ? (vencidas.length === 1 ? "1 atrasada" : vencidas.length + " atrasadas") : "", semInicio.length ? semInicio.length + " vencendo sem iniciar" : ""].filter(Boolean).join(" · ")}</b><small>Toque para ver</small></button>`;
  const linha = (t, txt) => `<div class="al-box"><button class="al-item" data-act="ir-tarefa" data-id="${t.id}"><span>${PRIO[prio(t)].i} <b>${esc(t.descricao)}</b></span><small>${txt}</small></button>${prazoRapido(t)}</div>`;
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

/* ---------- mudar prazo rápido (gestor) ---------- */
function somaSP(ms) { return new Date(ms).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16).replace(" ", "T"); }
function prazoRapido(t) {
  if (S.prazoDe === t.id) return `<div class="prazo-r"><input type="datetime-local" id="pz-${t.id}" value="${esc(t.prazo && t.prazo.includes("T") ? t.prazo : "")}" data-autofocus><button class="primary" data-act="pz-salvar" data-id="${t.id}">Salvar</button><button data-act="pz-fechar">✕</button></div>`;
  const am = somaSP(Date.now() + 864e5).slice(0, 10), hr = t.prazo && t.prazo.includes("T") ? t.prazo.slice(11) : "18:00";
  const op = [[somaSP(Date.now() + 2 * 3600e3), "+2 horas"], [am + "T08:00", "Amanhã 8h"], [am + "T" + hr, "Amanhã " + hr.replace(":00", "h")]];
  return `<div class="prazo-r"><span>📅 Novo prazo:</span>${op.map(([v, l]) => `<button data-act="pz" data-id="${t.id}" data-k="${v}">${l}</button>`).join("")}<button data-act="pz-outro" data-id="${t.id}">Outro…</button></div>`;
}

/* ---------- segurança ---------- */
const HORA = 3600e3;
const hhmm = ms => fmtH(ms);
const fotoSeg = (f, alt) => { const u = `/api/seg/fotos/${f.id}?k=${encodeURIComponent(S.chave)}`; return `<span class="sf-w"><button type="button" class="sf" data-act="ver-foto" data-k="${u}" data-id="${esc(alt)}"><img src="${u}" alt="${esc(alt)}" decoding="async"><small>${f.tipo === "ronda" ? esc(alt) + "<br>" : ""}${hhmm(f.em)}</small></button>${etiquetaLocal(f)}${(() => { const m = (f.suspeita || "").split(" · ").filter(x => !x.startsWith("fora da praça")).join(" · "); return m ? `<span class="geo fora" title="${esc(m)}">⚠ ${esc(m)}</span>` : ""; })()}</span>`; };
const locaisDaRonda = (lista, r) => [0, 1, 2].map(i => lista[((Math.max(r, 1) - 1) * 3 + i) % lista.length]);
const listaDe = fid => { const g = S.d.seg.guardas.find(x => x.id === fid); return g && g.locais && g.locais.length >= 3 ? g.locais : S.d.seg.locais; };
function infoTurno(t, fotos) {
  const fim = t.fim ? Number(t.fim) : Date.now(), ini = Number(t.inicio);
  const total = Math.floor((fim - ini) / HORA), fs = fotos.filter(f => f.turno_id === t.id);
  const rondas = [];
  for (let r = 1; r <= total; r++) { const hora = ini + r * HORA, com4 = hora >= Number(S.d.seg.ronda4 || 0), nomes = locaisDaRonda(listaDe(t.func_id), r).concat(com4 ? ["Rosto"] : []);
    rondas.push({ r, hora, nomes, fotos: nomes.map((_, l) => fs.find(f => f.tipo === "ronda" && f.rodada === r && f.local === l)) }); }
  return { ini, total, rondas, entrada: fs.find(f => f.tipo === "entrada"), saida: fs.find(f => f.tipo === "saida"), completas: rondas.filter(x => x.fotos.every(Boolean)).length };
}
function segGuarda() {
  const sg = S.d.seg, t = sg.turnos.find(x => !x.fim), L = locaisDaRonda(listaDe(S.d.eu.id), t ? Math.floor((Date.now() - Number(t.inicio)) / HORA) : 1);
  let h = `<div class="seg-nome ${t ? "on" : "off"}"><b>${esc(S.d.eu.nome)}</b><span>${t ? "🟢 Em serviço desde " + hhmm(t.inicio) : "🔴 Fora de serviço"}</span></div>`;
  if (!t) {
    h += `<div class="panel"><p style="margin:0">Chegou no local? Tire uma <b>foto do seu rosto</b> para começar o turno. Seu nome fica verde para o gestor.</p>
      <button class="primary big" data-act="seg-foto" data-k="entrada">📸 Cheguei: foto do rosto</button></div>`;
    return h + botaoPush();
  }
  const it = infoTurno(t, sg.fotos), r = it.total;
  if (r < 1) h += `<div class="panel"><p class="h3">Ronda</p><p style="margin:0">A primeira ronda é às <b>${hhmm(it.ini + HORA)}</b>. Nessa hora o alarme toca e você fotografa: ${esc(L.join(", "))}.</p></div>`;
  else {
    const at = it.rondas[r - 1], feita = at.fotos.every(Boolean);
    h += `<div class="panel ronda ${feita ? "ok" : "pend"}"><p class="h3">Ronda das ${hhmm(at.hora)}</p>${feita ? `<p class="ok-txt" style="margin:0">✔ Ronda completa. A próxima é às ${hhmm(at.hora + HORA)}.</p>` : `<p style="margin:0"><b>Fotografe os 3 locais agora${at.nomes.length > 3 ? " e, por último, o seu rosto" : ""}.</b></p>`}
      <div class="locais">${at.nomes.map((nome, l) => at.fotos[l] ? `<div class="loc ok">✔ ${esc(at.fotos[l].local_nome || nome)}<small>${hhmm(at.fotos[l].em)}</small></div>` : (l === 3 ? (at.fotos.slice(0, 3).every(Boolean) ? `<button class="primary loc" data-act="seg-foto" data-k="ronda" data-id="3">🤳 Por último: foto do seu rosto</button>` : `<div class="loc espera">🤳 Foto do seu rosto (depois dos 3 locais)</div>`) : `<button class="primary loc" data-act="seg-foto" data-k="ronda" data-id="${l}">📸 ${esc(nome)}</button>`)).join("")}</div></div>`;
    const faltaram = it.rondas.slice(0, -1).filter(x => !x.fotos.every(Boolean)).length;
    h += `<p class="note">Rondas completas neste turno: ${it.completas} de ${r}${faltaram ? ` · <span class="late-txt">${faltaram} incompleta${faltaram > 1 ? "s" : ""}</span>` : ""}.</p>`;
    if (!feita && S.alarmeVisto !== r) h += `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="al-t"><div class="modal-c alarme"><h2 id="al-t">🔔 Hora da ronda!</h2>
      <p style="margin:0">Fotografe agora: <b>${esc(at.nomes.filter(n => n !== "Rosto").join(", "))}</b>${at.nomes.length > 3 ? " e, por último, o seu <b>rosto</b>" : ""}.</p><button class="primary big" data-act="seg-alarme-ok">Vou fazer a ronda</button></div></div>`;
  }
  h += botaoPush();
  h += `<div class="panel" style="margin-top:22px"><p style="margin:0">Terminou o turno? Tire outra <b>foto do rosto</b>. Seu nome fica vermelho para o gestor.</p>
    ${S.confirm === "seg-saida:0" ? `<button class="big stop" data-act="seg-foto" data-k="saida">📸 Confirmar: foto do rosto e encerrar</button>` : `<button class="big" data-act="ask" data-k="seg-saida" data-id="0">Encerrar meu turno</button>`}</div>`;
  return h;
}
function segGestor(ro) {
  const sg = S.d.seg;
  let h = ro ? `<p class="note" style="margin-top:12px">👁 Você vê o que os seguranças fazem, mas não muda nada aqui.</p>` : "";
  h += listaPanicosHtml();
  h += `<p class="note" style="margin-top:12px">🟢 em serviço · 🔴 saiu · ⚪ ainda não chegou. Toque no nome para ver as fotos.</p>`;
  for (const [k, titulo] of [["dia", "☀️ Turno do dia"], ["noite", "🌙 Turno da noite"]]) {
    const gs = sg.guardas.filter(g => (g.turno || "dia") === k);
    h += `<section class="grupo"><div class="grupo-h"><h2>${titulo}</h2><span class="cnt">${gs.length}</span></div><div class="list">`;
    if (!gs.length) h += `<p class="note">Ninguém neste turno.</p>`;
    for (const g of gs) {
      if (!ro && S.segEd === g.id) { h += formGuarda(g); continue; }
      const ts = sg.turnos.filter(t => t.func_id === g.id), aberto = ts.find(t => !t.fim), ult = ts[0];
      let st = "⚪ Ainda não chegou", cls = "";
      if (aberto) {
        const it = infoTurno(aberto, sg.fotos), at = it.rondas[it.total - 1];
        st = `🟢 Chegou ${hhmm(aberto.inicio)} · rondas ${it.completas}/${it.total}`; cls = "on";
        if (aberto.pos_em && sg.base) { const pp = { lat: aberto.pos_lat, lng: aberto.pos_lng, precisao: aberto.pos_prec };
          st += foraDaBase(sg.base, pp) ? ` · <span class="late-txt">⚠ fora da praça (${fmtDist(distM(sg.base, pp))}) às ${hhmm(aberto.pos_em)}</span>` : ` · ✔ na praça às ${hhmm(aberto.pos_em)}`; }
        if (at && !at.fotos.every(Boolean) && Date.now() - at.hora > 10 * 60e3) st += ` · <span class="late-txt">⚠ ronda das ${hhmm(at.hora)} atrasada</span>`;
      } else if (ult) { st = `🔴 Saiu ${fmtDT(ult.fim)}`; cls = "off"; }
      h += `<article class="task guarda ${cls}"><div class="task-h" data-act="seg-abrir" data-id="${g.id}"><div class="t"><div class="d">${esc(g.nome)}</div><div class="meta"><span>🕐 ${esc(g.turno_ini || "")}–${esc(g.turno_fim || "")}</span><span>📍 ${(g.locais || []).length} locais</span><span>${st}</span></div></div><span class="chev" aria-hidden="true">›</span></div>`;
      if (S.segAberto === g.id) {
        h += `<div class="task-b">`;
        if (!ts.length) h += `<p class="note">Nenhum turno nos últimos 3 dias.</p>`;
        for (const t of ts) {
          const it = infoTurno(t, sg.fotos);
          h += `<div class="turno"><p class="h3">Turno de ${fmtDT(t.inicio)}${t.fim ? " até " + fmtDT(t.fim) : " · em andamento"}</p>
            <div class="sf-row"><span class="sf-l">Chegada</span>${it.entrada ? fotoSeg(it.entrada, "Rosto na chegada") : `<span class="note">sem foto</span>`}</div>`;
          it.rondas.forEach(x => h += `<div class="sf-row"><span class="sf-l">Ronda ${hhmm(x.hora)}</span>${x.fotos.map((f, l) => f ? fotoSeg(f, f.local_nome || x.nomes[l]) : `<span class="sf falta">faltou<br>${esc(x.nomes[l])}</span>`).join("")}</div>`);
          if (t.fim) h += `<div class="sf-row"><span class="sf-l">Saída</span>${it.saida ? fotoSeg(it.saida, "Rosto na saída") : `<span class="note">sem foto</span>`}${t.encerrado_por ? `<span class="note">encerrado/corrigido por ${esc(t.encerrado_por)}</span>` : ""}</div>`;
          if (!ro) h += S.segFim === t.id ? `<div class="panel"><label class="f">${t.fim ? "Hora certa da saída" : "Hora da saída"}<input id="fim-${t.id}" type="datetime-local" value="${inputDT(t.fim || Date.now())}"></label>
              <div class="row"><button class="primary" data-act="seg-encerrar" data-id="${t.id}">${t.fim ? "Salvar hora certa" : "Encerrar turno"}</button><button data-act="seg-fim-x">Cancelar</button></div></div>`
            : `<div class="row">${!t.fim ? `<button class="primary" data-act="seg-fim" data-id="${t.id}">■ Encerrar turno dele</button>` : `<button class="ghost" data-act="seg-fim" data-id="${t.id}">Corrigir hora de saída</button>`}${confirmBtn("seg-apagar", t.id, "Apagar turno (aberto por engano)")}</div>`;
          h += `</div>`;
        }
        const z = g.telefone ? `https://wa.me/55${g.telefone}?text=${encodeURIComponent("Olá " + g.nome + ", este é o app da segurança da decoração de Natal: " + location.origin + " . Entre digitando o seu celular.")}` : "";
        h += ro ? (g.telefone ? `<div class="row"><a class="zap" href="tel:+55${g.telefone}">📞 Ligar para ${esc(g.nome)}</a></div></div>` : `</div>`)
          : `<div class="row">${z ? `<a class="zap" href="${z}" target="_blank" rel="noopener">Enviar link</a>` : ""}<button data-act="seg-ed" data-id="${g.id}">Editar</button>${confirmBtn("del-func", g.id, "Remover")}</div></div>`;
      }
      h += `</article>`;
    }
    h += `</div></section>`;
  }
  if (ro) return h;
  h += S.segEd === "novo" ? formGuarda(null) : `<button class="primary" style="margin-top:16px;width:100%" data-act="seg-novo">＋ Cadastrar segurança</button>`;
  h += `<p class="note" style="margin-top:12px">📍 Os locais da ronda são de cada segurança: toque no nome, depois em <b>Editar</b>. A cada ronda o app pede 3 locais (alternando pela lista) e, por último, uma foto do rosto do segurança.</p>`;
  return h + relatorio() + configBase() + configPanico();
}
/* ---------- relatório para pagamento ---------- */
const inputDT = ms => { const d = new Date(Number(ms) - 3 * HORA); return d.toISOString().slice(0, 16); };
const hoje = () => new Date(Date.now() - 3 * HORA).toISOString().slice(0, 10);
const fmtHoras = ms => { const m = Math.round(ms / 60e3); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`; };
function resumoRel() {
  const por = new Map();
  for (const t of S.rel || []) {
    const r = por.get(t.func_id) || { id: t.func_id, nome: t.nome, turno: t.turno, turnos: [], ms: 0, abertos: 0, rondas: 0, esperadas: 0, suspeitas: 0 };
    const fim = t.fim ? Number(t.fim) : null, dur = fim ? fim - Number(t.inicio) : 0;
    r.turnos.push(t); r.ms += dur; if (!fim) r.abertos++; r.rondas += t.rondas_ok; r.esperadas += fim ? Math.floor(dur / HORA) : 0; r.suspeitas += t.suspeitas;
    por.set(t.func_id, r);
  }
  return [...por.values()];
}
function relatorio() {
  const de = S.relDe || hoje().slice(0, 8) + "01", ate = S.relAte || hoje();
  let h = `<section class="grupo"><div class="grupo-h"><h2>🧾 Relatório para pagamento</h2></div><div class="panel">
    <div class="grid2"><label class="f">De<input id="rel-de" type="date" value="${de}"></label><label class="f">Até<input id="rel-ate" type="date" value="${ate}"></label></div>
    <div class="row"><button class="primary" data-act="rel-gerar">Gerar relatório</button>${S.rel && S.rel.length ? `<button data-act="rel-csv">⬇ Baixar planilha</button>` : ""}</div>`;
  if (S.rel) {
    const rs = resumoRel();
    if (!rs.length) h += `<p class="note">Nenhum turno nesse período.</p>`;
    for (const r of rs) {
      h += `<div class="rel"><div class="rel-h" data-act="rel-abrir" data-id="${r.id}"><b>${esc(r.nome)}</b><span>${r.turnos.length} turno${r.turnos.length === 1 ? "" : "s"} · <b>${fmtHoras(r.ms)}</b> · rondas ${r.rondas}/${r.esperadas}${r.abertos ? ` · <span class="late-txt">${r.abertos} sem saída</span>` : ""}${r.suspeitas ? ` · <span class="late-txt">⚠ ${r.suspeitas} foto${r.suspeitas > 1 ? "s" : ""} suspeita${r.suspeitas > 1 ? "s" : ""}</span>` : ""}</span></div>`;
      if (S.relAberto === r.id) h += `<table class="rel-t"><tr><th>Chegada</th><th>Saída</th><th>Horas</th><th>Rondas</th></tr>${r.turnos.map(t => `<tr><td>${fmtDT(t.inicio)}</td><td>${t.fim ? fmtDT(t.fim) + (t.encerrado_por ? ` <small>(${esc(t.encerrado_por)})</small>` : "") : `<span class="late-txt">sem saída</span>`}</td><td>${t.fim ? fmtHoras(t.fim - t.inicio) : "—"}</td><td>${t.rondas_ok}/${t.fim ? Math.floor((t.fim - t.inicio) / HORA) : "—"}</td></tr>`).join("")}</table>`;
      h += `</div>`;
    }
    if (rs.some(r => r.abertos)) h += `<p class="note">Turnos "sem saída" não entram nas horas. Encerre ou corrija a saída tocando no nome do segurança acima.</p>`;
  }
  return h + `</div></section>`;
}
function baixarRelatorio() {
  const q = v => `"${String(v).replace(/"/g, '""')}"`, linhas = [["Nome", "Chegada", "Saída", "Horas", "Horas (decimal)", "Rondas completas", "Rondas esperadas", "Fotos suspeitas", "Encerrado por"].map(q).join(";")];
  for (const t of S.rel || []) { const dur = t.fim ? t.fim - t.inicio : 0;
    linhas.push([t.nome, fmtDT(t.inicio), t.fim ? fmtDT(t.fim) : "sem saída", t.fim ? fmtHoras(dur) : "", t.fim ? (dur / HORA).toFixed(2).replace(".", ",") : "", t.rondas_ok, t.fim ? Math.floor(dur / HORA) : "", t.suspeitas, t.encerrado_por || ""].map(q).join(";")); }
  linhas.push(""); linhas.push([q("TOTAL POR NOME")].join(";"));
  for (const r of resumoRel()) linhas.push([r.nome, "", "", fmtHoras(r.ms), (r.ms / HORA).toFixed(2).replace(".", ","), r.rondas, r.esperadas, r.suspeitas, ""].map(q).join(";"));
  const blob = new Blob(["\ufeff" + linhas.join("\r\n")], { type: "text/csv;charset=utf-8" }), u = URL.createObjectURL(blob), l = document.createElement("a");
  l.href = u; l.download = `relatorio-segurancas-${S.relDe || ""}-a-${S.relAte || ""}.csv`; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000);
}

/* ---------- ver foto em tela cheia, com botão de voltar ---------- */
function fecharFoto(viaHistorico) {
  const el = document.getElementById("visor"); if (!el) return; el.remove();
  if (!viaHistorico && history.state && history.state.visor) history.back();
}
function abrirFoto(src, legenda) {
  fecharFoto(true);
  const el = document.createElement("div"); el.id = "visor"; el.className = "visor"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
  el.innerHTML = `<div class="visor-b"><button class="primary" id="visor-x">← Voltar</button><span>${esc(legenda || "")}</span></div><img src="${src}" alt="${esc(legenda || "Foto")}">`;
  document.body.appendChild(el);
  el.querySelector("#visor-x").onclick = () => fecharFoto();
  el.onclick = ev => { if (ev.target === el) fecharFoto(); };
  history.pushState({ visor: 1 }, "");
}
window.addEventListener("popstate", () => fecharFoto(true));
document.addEventListener("keydown", ev => { if (ev.key === "Escape") fecharFoto(); });
document.addEventListener("click", ev => {
  const l = ev.target.closest && ev.target.closest("a[href]"); if (!l) return;
  const img = l.querySelector("img"); if (!img || !l.getAttribute("href").startsWith("/api/")) return;
  ev.preventDefault(); ev.stopPropagation(); abrirFoto(l.getAttribute("href"), img.getAttribute("alt"));
}, true);

/* ---------- câmera ao vivo do segurança (sem galeria) ---------- */
async function enviarFotoSeg(blob, g, extra) {
  const hd = Object.assign({ "content-type": "image/jpeg", "x-chave": S.chave, "x-tipo": S.segTipo, "x-local": S.segLocal }, extra || {});
  if (g) Object.assign(hd, { "x-lat": String(g.lat), "x-lng": String(g.lng), "x-prec": String(g.precisao) });
  const r = await fetch("/api/seg/foto", { method: "POST", headers: hd, body: blob });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || "Falha ao enviar a foto.");
}
let camStream = null, camLocal = null;
function fecharCamera() { if (camStream) camStream.getTracks().forEach(t => t.stop()); camStream = null; const el = document.getElementById("camera"); if (el) el.remove(); }
async function abrirCamera() {
  const rostoRonda = S.segTipo === "ronda" && String(S.segLocal) === "3", frente = S.segTipo !== "ronda" || rostoRonda;
  const titulo = S.segTipo === "entrada" ? "Foto do rosto: chegada" : S.segTipo === "saida" ? "Foto do rosto: saída" : rostoRonda ? "Foto do rosto: ronda" : "Foto da ronda";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camAlternativa(frente);
  fecharCamera();
  const el = document.createElement("div"); el.id = "camera"; el.className = "camera"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
  el.innerHTML = `<p class="cam-t">${esc(titulo)}</p><video id="cam-v" autoplay playsinline muted></video><p class="cam-s" id="cam-s">Abrindo a câmera e pegando a localização…</p>
    <div class="cam-b"><button class="ghost" id="cam-x">Cancelar</button><button class="primary big" id="cam-ok" disabled>📸 Tirar foto</button></div>`;
  document.body.appendChild(el);
  el.querySelector("#cam-x").onclick = fecharCamera;
  camLocal = null; pegarLocal(12000).then(g => { camLocal = g; const s = document.getElementById("cam-s"); if (s) s.textContent = g ? `📍 Localização pronta (±${g.precisao} m)` : "⚠ Sem localização: ligue a Localização do celular."; });
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: frente ? "user" : { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
    const v = el.querySelector("#cam-v"); v.srcObject = camStream; await v.play().catch(() => {});
    const ok = el.querySelector("#cam-ok"); ok.disabled = false;
    ok.onclick = async () => {
      ok.disabled = true; ok.textContent = "Enviando…";
      try {
        const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement("canvas");
        c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k); const x = c.getContext("2d");
        x.drawImage(v, 0, 0, c.width, c.height);
        const g = camLocal, b = S.d.seg && S.d.seg.base, agora = new Date();
        const linhas = [`${S.d.eu.nome} · ${titulo}${S.segTipo === "ronda" && !rostoRonda ? " · " + ((document.querySelector(`[data-act="seg-foto"][data-id="${S.segLocal}"]`) || {}).textContent || "").replace("📸", "").trim() : ""}`,
          agora.toLocaleString("pt-BR", { timeZone: TZ }) + (g ? ` · ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)} ±${g.precisao}m` : " · sem localização") + (g && b ? ` · ${foraDaBase(b, g) ? "FORA " + fmtDist(distM(b, g)) : "na praça"}` : "")];
        const fs = Math.max(14, Math.round(c.width / 38)); x.fillStyle = "rgba(0,0,0,.6)"; x.fillRect(0, c.height - fs * 3, c.width, fs * 3);
        x.fillStyle = "#fff"; x.font = `bold ${fs}px sans-serif`; linhas.forEach((l, i) => x.fillText(l, fs / 2, c.height - fs * (1.9 - i * 1.2), c.width - fs));
        const blob = await new Promise((res, rej) => c.toBlob(bb => bb ? res(bb) : rej(new Error("Não consegui gerar a foto.")), "image/jpeg", 0.75));
        await enviarFotoSeg(blob, g, { "x-origem": "camera" }); S.err = ""; fecharCamera(); carregar();
      } catch (e) { ok.disabled = false; ok.textContent = "📸 Tirar foto"; const s = document.getElementById("cam-s"); if (s) s.textContent = "⚠ " + e.message; }
    };
  } catch (e) { fecharCamera(); camAlternativa(frente); }
}
function camAlternativa(frente) {
  // Celular sem câmera ao vivo no navegador: usa a câmera do sistema (a foto fica marcada se for antiga)
  const inp = document.getElementById("foto-seg"); inp.setAttribute("capture", frente ? "user" : "environment"); inp.value = ""; inp.click();
}

/* ---------- local de trabalho (praça) ---------- */
function pegarLocal(espera = 8000) {
  return new Promise(res => { if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, precisao: Math.round(p.coords.accuracy) }), () => res(null), { enableHighAccuracy: true, timeout: espera, maximumAge: 0 }); });
}
function distM(a, b) { const R = 6371e3, k = Math.PI / 180, dLat = (b.lat - a.lat) * k, dLng = (b.lng - a.lng) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : Math.round(m) + " m";
const foraDaBase = (b, p) => b && p && p.lat !== null && p.lat !== undefined ? distM(b, p) - Math.min(p.precisao || 0, 500) > b.raio : false;
function etiquetaLocal(p) {
  const b = S.d.seg && S.d.seg.base; if (!p || p.lat === null || p.lat === undefined) return "";
  const u = `https://maps.google.com/?q=${p.lat},${p.lng}`;
  if (!b) return `<a class="geo" href="${u}" target="_blank" rel="noopener">📍 mapa</a>`;
  const d = distM(b, p); return foraDaBase(b, p) ? `<a class="geo fora" href="${u}" target="_blank" rel="noopener">⚠ ${fmtDist(d)} fora</a>` : `<a class="geo" href="${u}" target="_blank" rel="noopener">✔ na praça</a>`;
}
function configBase() {
  const b = S.d.seg.base;
  return `<section class="grupo"><div class="grupo-h"><h2>📍 Local de trabalho (praça)</h2></div><div class="panel">
    ${b ? `<p style="margin:0">Definido: <a href="https://maps.google.com/?q=${b.lat},${b.lng}" target="_blank" rel="noopener">ver no mapa</a>, raio de <b>${fmtDist(b.raio)}</b>. Quando um segurança aparecer fora desse raio, os gestores recebem um aviso sem som.</p>`
      : `<p style="margin:0">Ainda não definido. Defina o ponto da praça para o app avisar quando um segurança sair dela.</p>`}
    <p class="note" style="margin:0">O app confere a posição em cada foto (chegada, rondas e saída) e a cada 3 minutos enquanto o app do segurança estiver aberto. Com o celular bloqueado e o app fechado, o celular não manda a localização.</p>
    <div class="grid2"><label class="f">Raio em metros<input id="bs-raio" type="number" inputmode="numeric" min="50" max="20000" value="${b ? b.raio : 300}"></label>
    <label class="f">Ou cole o link do Google Maps / coordenadas<input id="bs-link" placeholder="-23.53, -46.79"></label></div>
    <div class="row"><button class="primary" data-act="base-aqui">📍 Estou na praça: usar minha localização</button><button data-act="base-link">Salvar pelo link</button>${b ? confirmBtn("base-tirar", 0, "Tirar") : ""}</div></div></section>`;
}

/* ---------- botão de pânico ---------- */
const PANICO_ATIVO = 60 * 60e3;
const panicoAberto = p => !p.atendido_em && Date.now() - Number(p.em) < PANICO_ATIVO;
const linkMapa = p => p.lat !== null && p.lat !== undefined ? `https://maps.google.com/?q=${p.lat},${p.lng}` : "";
const margem = p => p.precisao ? ` (margem de ±${p.precisao >= 1000 ? (p.precisao / 1000).toFixed(1).replace(".", ",") + " km" : p.precisao + " m"})` : "";
function statusPanico() {
  const meu = (S.d.panicos || [])[0], ab = meu && Date.now() - Number(meu.em) < PANICO_ATIVO ? meu : null, c = (S.d.centrais || [])[0];
  let h = "";
  if (ab) {
    const txt = encodeURIComponent(`🆘 PÂNICO: ${S.d.eu.nome} precisa de ajuda!` + (linkMapa(ab) ? " Local: " + linkMapa(ab) : ""));
    h += `<div class="panico-st ${ab.atendido_em ? "ok" : ""}" role="status"><b>${ab.atendido_em ? `✅ ${esc(ab.atendido_por || "A central")} viu o seu pedido às ${hhmm(ab.atendido_em)}. A ajuda está a caminho.` : `🆘 Pedido de ajuda enviado às ${hhmm(ab.em)}. Avisando ${c ? esc(c.nome) : "a central"}…`}</b>
      ${linkMapa(ab) ? "" : `<small>Sem localização do celular. Diga por telefone onde você está.</small>`}
      ${c ? `<div class="row"><a class="primary-a" href="tel:+55${c.telefone}">📞 Ligar para ${esc(c.nome)}</a><a class="zap" href="https://wa.me/55${c.telefone}?text=${txt}" target="_blank" rel="noopener">WhatsApp</a></div>` : ""}</div>`;
  }
  return h;
}
function barraPanico() {
  return `<div class="panico-bar"><button class="panico-btn" id="btn-panico" aria-label="Botão de pânico: segure por 2 segundos"><span class="enche"></span><span class="txt">🆘 PÂNICO · segure 2 segundos</span></button></div>`;
}
let segurando = null;
function soltarPanico() { if (!segurando) return; clearTimeout(segurando); segurando = null; const b = document.getElementById("btn-panico"); if (b) b.classList.remove("hold"); }
document.addEventListener("pointerdown", ev => {
  const b = ev.target.closest && ev.target.closest("#btn-panico"); if (!b || segurando) return;
  ev.preventDefault(); b.classList.add("hold"); navigator.vibrate && navigator.vibrate(40);
  segurando = setTimeout(() => { segurando = null; b.classList.remove("hold"); dispararPanico(); }, 2000);
});
["pointerup", "pointercancel", "pointerleave"].forEach(t => document.addEventListener(t, soltarPanico, true));
document.addEventListener("contextmenu", ev => { if (ev.target.closest && ev.target.closest("#btn-panico")) ev.preventDefault(); });
async function dispararPanico() {
  navigator.vibrate && navigator.vibrate([300, 100, 300]);
  try { await api("POST", "/api/seg/panico", {}); S.err = ""; } catch (e) { S.err = "Não consegui avisar pela internet. LIGUE AGORA para a central. (" + e.message + ")"; }
  carregar();
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
    async p => { try { await api("POST", "/api/seg/panico", { lat: p.coords.latitude, lng: p.coords.longitude, precisao: Math.round(p.coords.accuracy) }); carregar(); } catch (e) {} },
    () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}
// Aviso de pânico para quem recebe (Alex: tela cheia com sirene) e para os gestores (faixa sem som)
function avisoPanico() {
  if (G() ? false : !S.d.eu.panico) return "";
  const ab = (S.d.panicos || []).filter(panicoAberto);
  let h = "";
  if (!G() && S.d.teste) h += `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="tst-t"><div class="modal-c alarme"><h2 id="tst-t">🔔 TESTE do alarme de pânico</h2>
    <p style="margin:0">Isto é <b>só um teste</b> enviado por ${esc(S.d.teste.por)}. Ninguém está em perigo.</p><p style="margin:0">Quando um segurança apertar o pânico, o alarme vai tocar assim. Ouviu?</p>
    <button class="primary big" data-act="teste-ok">✅ Ouvi o alarme</button></div></div>`;
  if (!ab.length) return h;
  if (G()) return h + ab.map(p => `<div class="panico-faixa" role="alert"><b>🆘 PÂNICO: ${esc(p.nome)} pediu ajuda às ${hhmm(p.em)}</b>
    <div class="row">${linkMapa(p) ? `<a href="${linkMapa(p)}" target="_blank" rel="noopener">📍 Ver no mapa${margem(p)}</a>` : `<span>sem localização</span>`}${p.telefone ? `<a href="tel:+55${p.telefone}">📞 Ligar</a>` : ""}<button data-act="atender" data-id="${p.id}">✅ Estou atendendo</button></div></div>`).join("");
  return h + `<div class="modal panico-modal" role="alertdialog" aria-modal="true" aria-labelledby="pn-t"><div class="modal-c alarme">${ab.map(p => `<div class="pn">
    <h2 id="pn-t">🆘 PÂNICO: ${esc(p.nome)}</h2><p style="margin:0">Pediu ajuda às <b>${hhmm(p.em)}</b>.${linkMapa(p) ? ` Local${margem(p) || " sem margem informada"}. Se a margem for grande, confirme por telefone onde ele está.` : " O celular dele não mandou a localização."}</p>
    <div class="row">${linkMapa(p) ? `<a class="primary-a" href="${linkMapa(p)}" target="_blank" rel="noopener">📍 Ver no mapa</a>` : ""}${p.telefone ? `<a class="primary-a" href="tel:+55${p.telefone}">📞 Ligar para ${esc(p.nome)}</a>` : ""}</div>
    <button class="primary big" data-act="atender" data-id="${p.id}">✅ Estou atendendo</button></div>`).join("")}</div></div>`;
}
function listaPanicosHtml() {
  const l = (S.d.panicos || []).filter(p => !panicoAberto(p)).slice(0, 5);
  if (!l.length) return "";
  return `<details class="panel" style="margin-top:12px"><summary><b>🆘 Pânicos nas últimas 24 horas (${l.length})</b></summary>${l.map(p => `<p style="margin:6px 0 0">${esc(p.nome)} · ${fmtDT(p.em)}${p.atendido_em ? ` · atendido por ${esc(p.atendido_por)} às ${hhmm(p.atendido_em)}` : " · ninguém marcou que atendeu"}${linkMapa(p) ? ` · <a href="${linkMapa(p)}" target="_blank" rel="noopener">mapa${margem(p)}</a>` : ""}</p>`).join("")}</details>`;
}
function configPanico() {
  const cs = S.d.centrais || [], ts = S.d.testes || [];
  let h = `<section class="grupo"><div class="grupo-h"><h2>🆘 Quem ouve o alarme do pânico</h2><span class="cnt">${cs.length}</span></div><div class="panel">
    <p class="note" style="margin:0">Quando um segurança segura o botão de pânico, o alarme toca no celular destas pessoas. Elas também veem os seguranças, sem poder mudar nada, e recebem tarefas normalmente.</p>`;
  for (const c of cs) {
    const t = [...ts].reverse().find(x => x.para === c.id);
    h += `<div class="p"><span>${esc(c.nome)}<br><small class="note">${esc(fmtTel(c.telefone))}${t ? ` · teste ${t.ok ? `<span class="ok-txt">✔ ouviu às ${hhmm(t.ok)}</span>` : `enviado às ${hhmm(t.em)}, esperando`}` : ""}</small></span>
      <a class="zap" href="https://wa.me/55${c.telefone}?text=${encodeURIComponent("Olá " + c.nome + ", você vai receber o alarme do botão de pânico dos seguranças. Entre no app: " + location.origin + " digitando o seu celular e toque em Ativar avisos.")}" target="_blank" rel="noopener">Enviar link</a>
      <button data-act="testar-alarme" data-id="${c.id}">🔔 Testar alarme</button>${confirmBtn("del-central", c.id, "Tirar")}</div>`;
  }
  h += `<div class="grid2" style="margin-top:8px"><label class="f">Nome<input id="ct-nome" maxlength="60"></label><label class="f">Celular com DDD<input id="ct-tel" type="tel" inputmode="numeric" placeholder="11 98765-4321"></label></div>
    <button data-act="add-central">＋ Adicionar</button></div></section>`;
  return h;
}
// Sirene: toca sem parar enquanto houver pânico sem atendimento (ou um teste) para quem recebe o pânico
let sirene = null;
function checarSirene() {
  const quer = S.d && !G() && S.d.eu.panico && ((S.d.panicos || []).some(panicoAberto) || !!S.d.teste);
  if (!quer) { if (sirene) { clearInterval(sirene); sirene = null; } return; }
  if (sirene) return;
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); } catch (e) { return; }
  const uivo = () => { try { const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime; o.type = "sawtooth";
    o.frequency.setValueAtTime(650, t0); o.frequency.linearRampToValueAtTime(1500, t0 + .7); o.frequency.linearRampToValueAtTime(650, t0 + 1.4);
    g.gain.setValueAtTime(.35, t0); g.gain.setValueAtTime(.35, t0 + 1.35); g.gain.linearRampToValueAtTime(.001, t0 + 1.45);
    o.connect(g); g.connect(audio.destination); o.start(t0); o.stop(t0 + 1.45); navigator.vibrate && navigator.vibrate([700, 200, 700]); } catch (e) {} };
  uivo(); sirene = setInterval(uivo, 1500);
}
function formGuarda(g) {
  return `<div class="panel"><p class="h3">${g ? "Editar segurança" : "Novo segurança"}</p><div class="grid2"><label class="f">Nome<input id="sg-nome" maxlength="60" value="${esc(g ? g.nome : "")}" data-autofocus></label>
    <label class="f">Celular com DDD<input id="sg-tel" type="tel" inputmode="numeric" value="${esc(g ? fmtTel(g.telefone) : "")}" placeholder="11 98765-4321"></label></div>
    <div class="grid3"><label class="f">Turno<select id="sg-turno"><option value="dia" ${!g || g.turno !== "noite" ? "selected" : ""}>☀️ Dia</option><option value="noite" ${g && g.turno === "noite" ? "selected" : ""}>🌙 Noite</option></select></label>
    <label class="f">Entrada<input id="sg-ini" type="time" value="${esc(g ? g.turno_ini : "07:00")}"></label><label class="f">Saída<input id="sg-fim" type="time" value="${esc(g ? g.turno_fim : "19:00")}"></label></div>
    <label class="f">Locais da ronda (um por linha, mínimo 3)<textarea id="sg-locais" rows="6" placeholder="Portão principal&#10;Árvore da praça&#10;Palco&#10;Estacionamento">${esc((g && g.locais ? g.locais : S.d.seg.locais).join("\n"))}</textarea></label>
    <p class="note">A cada ronda o app pede 3 locais da lista, alternando. Ex.: com 6 locais, numa ronda são os 3 primeiros e na seguinte os outros 3.</p>
    <div class="row"><button class="primary" data-act="seg-salvar">Salvar</button><button data-act="seg-cancel">Cancelar</button></div></div>`;
}
// Alarme dentro do app (toca enquanto o app está aberto)
let audio = null, tocando = null;
function tocar(on) {
  if (!on) { if (tocando) { clearInterval(tocando); tocando = null; } return; }
  if (tocando) return;
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); } catch (e) { return; }
  const bip = () => { try { [0, .35, .7].forEach(d => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(.4, audio.currentTime + d); g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + d + .3); o.start(audio.currentTime + d); o.stop(audio.currentTime + d + .3); });
    navigator.vibrate && navigator.vibrate([400, 150, 400, 150, 400]); } catch (e) {} };
  bip(); tocando = setInterval(bip, 3000);
  setTimeout(() => tocar(false), 2 * 60e3);
}
document.addEventListener("click", () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); } catch (e) {} }, { capture: true });
function checarAlarme() {
  if (!S.d || G() || !S.d.eu.seguranca) return;
  const t = S.d.seg.turnos.find(x => !x.fim); if (!t) return;
  const it = infoTurno(t, S.d.seg.fotos), r = it.total; if (r < 1) return;
  const feita = it.rondas[r - 1].fotos.every(Boolean);
  S.alarmeRodada = r;
  if (!feita && S.alarmeVisto !== r && !tocando) { tocar(true); render(); }
  if (feita) tocar(false);
}
setInterval(checarAlarme, 10000);
// Enquanto o app do segurança está aberto, manda a posição a cada 3 minutos (para avisar se sair da praça)
let ultimaPos = 0;
async function enviarPosicao() {
  if (!S.d || G() || !S.d.eu.seguranca || document.hidden || Date.now() - ultimaPos < 170e3) return;
  if (!S.d.seg.turnos.some(x => !x.fim)) return;
  ultimaPos = Date.now(); const g = await pegarLocal(); if (g) api("POST", "/api/seg/posicao", g).catch(() => {});
}
setInterval(enviarPosicao, 30000); document.addEventListener("visibilitychange", () => { if (!document.hidden) { ultimaPos = 0; enviarPosicao(); } });
function fotoPequena(file) {
  return new Promise((res, rej) => {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
      c.toBlob(b => b ? res(b) : rej(new Error("Não consegui ler a foto.")), "image/jpeg", 0.75); };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("Não consegui ler essa foto. Tente tirar de novo.")); };
    img.src = u;
  });
}

/* ---------- avisos no celular ---------- */
const temPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const chavePush = () => "push_" + (G() ? "gestor" : EU());
function botaoPush() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const instalado = window.matchMedia && matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (temPush() && Notification.permission === "granted" && ls.get(chavePush()))
    return `<div class="push ok"><span>🔔 Avisos ligados neste celular.</span><button class="ghost" data-act="push-teste">Mandar aviso de teste</button></div>`;
  if (temPush() && Notification.permission === "denied") return `<div class="push"><span>🔕 Os avisos estão <b>bloqueados</b> neste celular. ${ios ? "No iPhone: Ajustes › Notificações › Natal Osasco › Permitir." : "Toque no cadeado ao lado do endereço do site › Notificações › Permitir. Depois volte aqui."}</span></div>`;
  if (!temPush()) {
    if (ios && !instalado) return `<div class="push ios"><span><b>🔔 Para receber avisos no iPhone:</b><ol><li>Abra este site no <b>Safari</b>.</li><li>Toque em <b>Compartilhar</b> (quadrado com a seta ⬆️ embaixo).</li><li>Toque em <b>Adicionar à Tela de Início</b> e depois em Adicionar.</li><li>Feche o Safari e abra o app pelo <b>ícone novo</b> na tela do celular.</li><li>Entre com o seu celular e aí vai aparecer o botão <b>Ativar avisos</b>.</li></ol></span></div>`;
    return `<div class="push"><span>🔕 Este navegador não recebe avisos. ${ios ? "Atualize o iPhone (iOS 16.4 ou mais novo) e abra o app pelo ícone da Tela de Início." : "No Android, abra o site no <b>Google Chrome</b> (não pelo WhatsApp ou outro app) e toque em Ativar avisos."}</span></div>`;
  }
  const android = /Android/i.test(navigator.userAgent);
  const dicaAndroid = android && !instalado ? `<small class="note" style="flex-basis:100%">📱 <b>Android:</b> 1) toque em <b>Ativar avisos</b> e em Permitir. 2) Para ficar como app: no Chrome, toque nos <b>3 pontinhos ⋮</b> lá em cima › <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b>) e abra pelo ícone.</small>` : "";
  return `<div class="push"><span>🔔 ${S.d.eu.seguranca ? "Ative para o <b>alarme da ronda</b> tocar no celular mesmo com o app fechado." : S.d.eu.panico ? "Ative para o <b>alarme do pânico</b> tocar no seu celular mesmo com o app fechado." : `Receba as tarefas novas${G() ? ", o pânico dos seguranças (sem som)" : " e o aviso de prazo"} direto no celular.`}</span><button class="primary" data-act="push">Ativar avisos</button>${dicaAndroid}</div>`;
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
  [["wz-prazo", "prazo"], ["wz-titulo", "titulo"], ["wz-det", "detalhes"], ["wz-local", "local"]].forEach(([id, k]) => { const el = document.getElementById(id); if (el) W[k] = el.value.trim(); });
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
    case "push-teste": try { await assinarPush(true); S.err = ""; } catch (e) { S.err = "Não consegui mandar o teste: " + e.message; } return draw();
    case "tab": S.tab = b.dataset.k; S.ed = null; if (S.tab === "nova" && S.wz.criada) S.wz = novoWz(); return draw();
    case "fprio": S.fPrio = b.dataset.k; return draw();
    case "painel-filtro": S.tab = "acompanhar"; S.fStatus = b.dataset.k; S.fPrio = "todas"; draw(); window.scrollTo({ top: 0 }); return;
    case "painel-pessoa": S.fPessoa = String(id); draw(); window.scrollTo({ top: 0 }); return;
    case "painel-local": S.fLocal = b.dataset.k; draw(); window.scrollTo({ top: 0 }); return;
    case "limpar-filtros": S.fLocal = ""; S.fPessoa = ""; return draw();
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
      S.wz = Object.assign(novoWz(), { pessoas: new Set(m.pessoas.filter(i => S.d.funcionarios.some(f => f.id === i))), prioridade: PRIO[m.prioridade] ? m.prioridade : "normal", titulo: m.titulo, detalhes: m.detalhes || "", local: m.local || "", modelo: m.titulo });
      S.wz.passo = S.wz.pessoas.size ? 2 : 1; draw(); window.scrollTo({ top: 0 }); return; }
    case "pz": return acao("POST", `/api/tarefas/${id}/prazo`, { prazo: b.dataset.k });
    case "pz-outro": S.prazoDe = id; return draw();
    case "pz-fechar": S.prazoDe = null; return draw();
    case "pz-salvar": { const v = val("pz-" + id); if (!v) { S.err = "Escolha a nova data e hora."; return draw(); } S.prazoDe = null; return acao("POST", `/api/tarefas/${id}/prazo`, { prazo: v }); }
    case "arquivar": S.open.delete(id); return acao("POST", `/api/tarefas/${id}/arquivar`);
    case "desarquivar": S.open.delete(id); return acao("POST", `/api/tarefas/${id}/arquivar`, { desfazer: true });
    case "arq-todas": return acao("POST", "/api/tarefas/arquivar-concluidas");
    case "ver-foto": return abrirFoto(b.dataset.k, b.dataset.id);
    case "seg-foto": { tocar(false); S.segTipo = b.dataset.k; S.segLocal = b.dataset.id || "0"; return abrirCamera(); }
    case "seg-alarme-ok": tocar(false); S.alarmeVisto = S.alarmeRodada; return draw();
    case "seg-abrir": S.segAberto === id ? S.segAberto = null : S.segAberto = id; return draw();
    case "seg-novo": S.segEd = "novo"; return draw();
    case "seg-ed": S.segEd = id; return draw();
    case "seg-cancel": S.segEd = null; return draw();
    case "seg-salvar": { const body = { id: S.segEd === "novo" ? null : S.segEd, nome: val("sg-nome"), telefone: val("sg-tel"), turno: val("sg-turno"), turno_ini: val("sg-ini"), turno_fim: val("sg-fim"), locais: val("sg-locais").split("\n") };
      try { S.busy = true; await api("POST", "/api/seg/guardas", body); S.segEd = null; S.err = ""; } catch (e) { S.err = e.message; } S.busy = false; return carregar(); }
    case "seg-locais": S.segLocais = !S.segLocais; return draw();
    case "seg-locais-salvar": S.segLocais = false; return acao("POST", "/api/seg/locais", { locais: [val("lc-0"), val("lc-1"), val("lc-2")] });
    case "seg-fim": S.segFim = id; return draw();
    case "seg-fim-x": S.segFim = null; return draw();
    case "seg-encerrar": { const v = val("fim-" + id); S.segFim = null; return acao("POST", `/api/seg/turnos/${id}/encerrar`, { fim: v }); }
    case "seg-apagar": return acao("POST", `/api/seg/turnos/${id}/apagar`);
    case "rel-gerar": { const de = val("rel-de"), ate = val("rel-ate"); S.relDe = de; S.relAte = ate;
      try { S.busy = true; S.rel = (await api("GET", `/api/seg/relatorio?de=${de}&ate=${ate}`)).turnos; S.err = ""; } catch (e) { S.err = e.message; } S.busy = false; return draw(); }
    case "rel-csv": return baixarRelatorio();
    case "rel-abrir": S.relAberto = S.relAberto === id ? null : id; return draw();
    case "base-aqui": { b.disabled = true; b.textContent = "Pegando a localização…"; const g = await pegarLocal(15000);
      if (!g) { S.err = "Não consegui pegar a sua localização. Ligue a Localização do celular e permita para este site."; return draw(); }
      if (g.precisao > 150) S.err = `Atenção: a localização veio com margem de ±${g.precisao} m. Se possível, tente de novo ao ar livre.`;
      return acao("POST", "/api/seg/base", { lat: g.lat, lng: g.lng, raio: val("bs-raio") }); }
    case "base-link": { const t = val("bs-link"), m = t.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
      if (!m) { S.err = "Não achei as coordenadas. No Google Maps, segure o dedo no ponto e copie os números (ex.: -23.53, -46.79)."; return draw(); }
      return acao("POST", "/api/seg/base", { lat: m[1], lng: m[2], raio: val("bs-raio") }); }
    case "base-tirar": return acao("POST", "/api/seg/base", { remover: true });
    case "atender": return acao("POST", `/api/panicos/${id}/atender`);
    case "teste-ok": return acao("POST", "/api/teste-alarme/ok");
    case "testar-alarme": try { const r = await api("POST", `/api/seg/centrais/${id}/testar`); S.err = r.celulares ? "" : "Teste criado, mas essa pessoa ainda não ativou os avisos no celular. Ela só vai ouvir com o app aberto. Peça para entrar e tocar em Ativar avisos."; } catch (e) { S.err = e.message; } return carregar();
    case "add-central": return acao("POST", "/api/seg/centrais", { nome: val("ct-nome"), telefone: val("ct-tel") });
    case "del-central": return acao("POST", `/api/seg/centrais/${id}/remover`);
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
        const r = await api("POST", "/api/tarefas", { pessoas: [...W.pessoas], prazo: W.prazo, prioridade: W.prioridade, titulo: W.titulo, detalhes: W.detalhes, local: W.local, salvarModelo: !W.modelo && !!W.salvarModelo });
        try { await enviarArquivos(r.id, W.arquivos); } catch (e) { S.err = "Tarefa criada, mas um anexo falhou: " + e.message; }
        S.wz = novoWz(); S.wz.criada = r.id;
      } catch (e) { S.err = e.message; }
      S.busy = false; await carregar(); window.scrollTo({ top: 0 }); return; }
    // editar
    case "et": { const t = S.d.tarefas.find(x => x.id === id); S.ed = { id, pessoas: new Set(pessoasDe(t).map(p => p.func_id)), prioridade: prio(t) }; return draw(); }
    case "ed-pessoa": S.ed.pessoas.has(id) ? S.ed.pessoas.delete(id) : S.ed.pessoas.add(id); return draw();
    case "ed-prio": S.ed.prioridade = b.dataset.k; return draw();
    case "ed-save": { const body = { pessoas: [...S.ed.pessoas], prioridade: S.ed.prioridade, prazo: val("ed-prazo"), titulo: val("ed-titulo"), detalhes: val("ed-det"), local: val("ed-local") };
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
      const gt = document.getElementById("nf-gestor"); await acao("POST", "/api/funcionarios", { nome: n, telefone: t, gestor: !!(gt && gt.checked) }); if (gt) gt.checked = false; if (!S.err) { const a = document.getElementById("nf-nome"), b2 = document.getElementById("nf-tel"); if (a) a.value = ""; if (b2) b2.value = ""; } return; }
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
  if (ev.target.id === "f-local") { S.fLocal = ev.target.value; return draw(); }
  if (ev.target.id === "foto-seg") {
    const f0 = ev.target.files[0]; ev.target.value = ""; if (!f0) return;
    S.busy = true; S.err = ""; S.enviandoFoto = 1; draw();
    try { const [f, g] = await Promise.all([fotoPequena(f0), pegarLocal()]); await enviarFotoSeg(f, g, { "x-origem": "arquivo", "x-tirada": String(f0.lastModified || "") }); }
    catch (e) { S.err = e.message; }
    S.busy = false; S.enviandoFoto = null; return carregar();
  }
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
