(function () {
"use strict";
const TZ = "America/Sao_Paulo";
const app = document.getElementById("app");
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };

const S = { chave: ls.get("chave"), d: null, nomes: null, tab: null, open: new Set(), closed: new Set(),
  editing: null, editingObs: null, newTaskFor: null, newSetor: false, confirm: null, err: "", entrarGestor: false, busy: false };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDT = ms => ms ? new Date(Number(ms)).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtD = s => { if (!s) return "Sem prazo"; const [dt, hr] = s.split("T"); const [y, m, d] = dt.split("-"); return `${d}/${m}/${y}` + (hr ? ` às ${hr}` : ""); };
const agora = () => new Date().toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16).replace(" ", "T");
const atrasado = p => !!p && (p.includes("T") ? p < agora() : p < agora().slice(0, 10));

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
const pai = t => t.parent_id ? S.d.tarefas.find(x => x.id === t.parent_id) : null;
const bloqueada = t => { const p = pai(t); return !!(p && !p.fim && !t.inicio); };
function estado(t) {
  if (t.fim) return "ok";
  if (bloqueada(t)) return "bloq";
  const late = atrasado(t.prazo);
  if (t.inicio) return late ? "late-run" : "run";
  return late ? "late" : "pend";
}
const filhos = id => S.d.tarefas.filter(t => t.parent_id === id).sort((a, b) => a.id - b.id);
const nome = id => { if (!id) return "Sem responsável"; const f = S.d.funcionarios.find(x => x.id === id); return f ? f.nome : "Removido"; };

function vistas() { try { return new Set(JSON.parse(ls.get("vistas_" + EU()) || "[]")); } catch (e) { return new Set(); } }
function marcarVistas(ids) { const v = vistas(); ids.forEach(i => v.add(i)); ls.set("vistas_" + EU(), JSON.stringify([...v])); }
function novas() {
  if (!S.d || G()) return [];
  const v = vistas();
  return S.d.tarefas.filter(t => t.resp_id === EU() && !t.inicio && !t.fim && !bloqueada(t) && !v.has(t.id));
}
let ultimoAviso = null;
function avisar() {
  const n = novas(), ids = n.map(t => t.id).join(",");
  if (ultimoAviso !== null && ids && ids !== ultimoAviso && n.some(t => !ultimoAviso.split(",").includes(String(t.id)))) {
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
    const msg = n.length === 1 ? n[0].descricao : n.length + " tarefas novas para você";
    if ("Notification" in window && Notification.permission === "granted")
      navigator.serviceWorker && navigator.serviceWorker.ready.then(r => r.showNotification("Tarefa liberada", { body: msg, icon: "/icon-192.png", tag: "nova" })).catch(() => {});
  }
  ultimoAviso = ids;
}
async function carregar() {
  if (!S.chave) return;
  try { S.d = await api("GET", "/api/estado"); if (S.err.startsWith("Sem conexão")) S.err = ""; avisar(); }
  catch (e) { if (S.chave) S.err = "Sem conexão com o servidor. Tentando de novo…"; }
  render();
}
const fmtTel = d => !d ? "" : d.length === 11 ? `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}` : `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
const zap = (id, texto) => { const f = S.d.funcionarios.find(x => x.id === id); return f && f.telefone ? `https://wa.me/55${f.telefone}?text=${encodeURIComponent(texto)}` : null; };
const setorNome = t => (S.d.setores.find(s => s.id === t.setor_id) || {}).nome || "";

/* ---------- render ---------- */
let pending = false;
function render() {
  const a = document.activeElement;
  if (a && app.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && a.value) { pending = true; return; }
  pending = false; draw();
}
document.addEventListener("focusout", () => setTimeout(() => { if (pending) render(); }, 60));

function draw() {
  const role = document.getElementById("role"), stats = document.getElementById("stats");
  let h = S.err ? `<div class="banner">${esc(S.err)}</div>` : "";
  if (!S.chave || !S.d) {
    role.hidden = true; stats.innerHTML = "";
    if (S.chave && !S.d) { app.innerHTML = h + `<div class="empty">Carregando…</div>`; return; }
    app.innerHTML = h + entrada(); const f = app.querySelector("[data-autofocus]"); if (f) f.focus(); return;
  }
  role.hidden = false; role.textContent = (G() ? "Gestor" : S.d.eu.nome) + " · Sair";
  const ts = S.d.tarefas, c = { pend: 0, run: 0, ok: 0, late: 0 };
  ts.forEach(t => { const e = estado(t); if (e === "ok") c.ok++; else if (e === "run" || e === "late-run") c.run++; else c.pend++; if (e.startsWith("late")) c.late++; });
  stats.innerHTML = `<span>${ts.length} tarefas</span><span>${c.pend} a iniciar</span><span>${c.run} em andamento</span><span>${c.ok} concluídas</span>${c.late ? `<span>${c.late} atrasadas</span>` : ""}`;

  const tabs = G() ? [["todas", "Todas"], ["andamento", "Em andamento"], ["atrasadas", "Atrasadas"], ["concluidas", "Concluídas"], ["equipe", "Equipe"]]
    : [["minhas", "Minhas"], ["todas", "Todas"], ["atrasadas", "Atrasadas"], ["concluidas", "Concluídas"]];
  if (!S.tab || !tabs.some(x => x[0] === S.tab)) S.tab = G() ? "todas" : "minhas";
  const nv = novas();
  if (nv.length) h += `<div class="aviso"><b>🔔 ${nv.length === 1 ? "Você tem uma tarefa nova liberada" : "Você tem " + nv.length + " tarefas novas liberadas"}</b>
    <span>${nv.map(t => esc(t.descricao)).join(" · ")}</span>
    <div class="row"><button class="primary" data-act="ver-novas">Ver agora</button>${"Notification" in window && Notification.permission === "default" ? `<button data-act="permitir">Avisar no celular</button>` : ""}</div></div>`;
  h += `<nav class="tabs">${tabs.map(([k, l]) => `<button data-act="tab" data-k="${k}" class="${S.tab === k ? "on" : ""}">${l}</button>`).join("")}</nav>`;

  if (S.tab === "equipe") { app.innerHTML = h + equipe(); return; }

  if (G() && S.newSetor) h += `<div class="panel"><label class="f">Nome do setor<input id="ns-nome" placeholder="Ex.: Praça da Matriz" maxlength="80" data-autofocus></label><div class="row"><button class="primary" data-act="ns-save">Criar setor</button><button data-act="cancel">Cancelar</button></div></div>`;

  const filt = t => { const e = estado(t); switch (S.tab) {
    case "minhas": return t.resp_id === EU(); case "andamento": return e === "run" || e === "late-run";
    case "atrasadas": return e === "late" || e === "late-run"; case "concluidas": return e === "ok"; default: return true; } };
  let shown = 0;
  if (!S.d.setores.length) h += `<div class="empty">${G() ? "Nenhum setor ainda. Toque em <b>+ Setor</b> para criar o primeiro, como “Calçadão” ou “Praça da Matriz”." : "O gestor ainda não criou setores."}</div>`;
  for (const s of S.d.setores) {
    const all = ts.filter(t => t.setor_id === s.id && !t.parent_id);
    const list = all.filter(t => filt(t) || ts.some(c => c.parent_id === t.id && filt(c))).sort((a, b) => (a.prazo || "9999").localeCompare(b.prazo || "9999"));
    if (!list.length && S.tab !== "todas" && !(G() && S.newTaskFor === s.id)) continue;
    shown++;
    const done = all.filter(t => t.fim).length, closed = S.closed.has(s.id);
    h += `<section class="setor"><div class="setor-h">`;
    if (S.editing === "setor:" + s.id) h += `<input id="es-nome" value="${esc(s.nome)}" maxlength="80" data-autofocus><button class="primary" data-act="es-save" data-id="${s.id}">Salvar</button><button data-act="cancel">✕</button>`;
    else {
      h += `<h2 data-act="toggle-setor" data-id="${s.id}">${esc(s.nome)}</h2><span class="cnt">${done}/${all.length} feitas</span>`;
      if (G()) h += `<button class="ghost" data-act="es" data-id="${s.id}">Renomear</button>${confirmBtn("del-setor", s.id, "Excluir")}`;
    }
    h += `</div>`;
    if (!closed) {
      h += `<div class="list">`;
      if (!list.length) h += `<p class="note" style="padding:6px 2px">Nenhuma tarefa neste setor.</p>`;
      list.forEach(t => h += card(t));
      if (G()) h += S.newTaskFor === s.id ? form(null, s.id) : `<button data-act="nt" data-id="${s.id}">+ Tarefa em ${esc(s.nome)}</button>`;
      h += `</div>`;
    }
    h += `</section>`;
  }
  if (S.d.setores.length && !shown) h += `<div class="empty">${S.tab === "minhas" ? "Nenhuma tarefa no seu nome por enquanto." : "Nada neste filtro."}</div>`;
  if (G()) h += `<button class="primary fab" data-act="ns">+ Setor</button>`;
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
  let h = `<div class="welcome"><h2>Entrar</h2><p class="note">Digite o seu celular, o mesmo que você passou para o gestor.</p></div>
  <div class="panel"><label class="f">Seu celular com DDD<input id="tel" type="tel" inputmode="numeric" autocomplete="tel" placeholder="11 98765-4321" data-autofocus></label>
  <button class="primary big" data-act="login-f">Entrar</button></div>`;
  return h + `<div style="margin-top:28px;text-align:center"><button class="ghost" data-act="ir-gestor">Sou o gestor</button></div>`;
}

function equipe() {
  const fs = S.d.funcionarios;
  let h = `<div class="panel"><p class="h3">Novo funcionário</p><div class="grid2"><label class="f">Nome<input id="nf-nome" maxlength="60" placeholder="Ex.: Caio"></label>
  <label class="f">Celular com DDD<input id="nf-tel" type="tel" inputmode="numeric" placeholder="11 98765-4321"></label></div>
  <button class="primary" data-act="nf-save">Adicionar à equipe</button>
  <p class="note">Depois mande o link do site para a pessoa. Ela entra digitando o celular.</p></div>`;
  h += `<p class="h3" style="margin-top:18px">Equipe (${fs.length})</p><div class="team" style="margin-top:8px">`;
  if (!fs.length) h += `<p class="note">Ninguém cadastrado ainda.</p>`;
  for (const f of fs) {
    if (S.editing === "func:" + f.id) { h += `<div class="p" style="flex-wrap:wrap"><input id="ef-nome" value="${esc(f.nome)}" maxlength="60" data-autofocus style="flex:1 1 140px"><input id="ef-tel" type="tel" inputmode="numeric" value="${esc(fmtTel(f.telefone))}" style="flex:1 1 140px"><button class="primary" data-act="ef-save" data-id="${f.id}">Salvar</button><button data-act="cancel">✕</button></div>`; continue; }
    const n = S.d.tarefas.filter(t => t.resp_id === f.id && !t.fim).length;
    h += `<div class="p"><span>${esc(f.nome)}<br><small class="note">${esc(fmtTel(f.telefone)) || "sem celular"} · ${n} em aberto</small></span>${f.telefone ? `<a href="https://wa.me/55${f.telefone}?text=${encodeURIComponent("Olá " + f.nome + ", este é o app de tarefas da decoração de Natal: " + location.origin + " . Entre digitando o seu celular.")}" target="_blank" rel="noopener"><button class="ghost">Enviar link</button></a>` : ""}<button class="ghost" data-act="ef" data-id="${f.id}">Editar</button>${confirmBtn("del-func", f.id, "Remover")}</div>`;
  }
  return h + `</div><div class="panel" style="margin-top:18px"><p class="h3">Link para mandar à equipe</p><p style="margin:0;font-weight:600;overflow-wrap:anywhere">${esc(location.origin)}</p>
  <div class="row"><button data-act="copiar">Copiar link</button><a href="https://wa.me/?text=${encodeURIComponent("Tarefas da decoração de Natal: " + location.origin)}" target="_blank" rel="noopener"><button>Enviar no WhatsApp</button></a></div></div>`;
}

function form(t, setorId, paiId) {
  const opts = `<option value="">Sem responsável</option>` + S.d.funcionarios.map(f => `<option value="${f.id}" ${t && t.resp_id === f.id ? "selected" : ""}>${esc(f.nome)}</option>`).join("");
  return `<div class="panel"><label class="f">Tarefa<textarea id="tf-desc" maxlength="500" placeholder="Ex.: Instalar cascata de luz na fachada" data-autofocus>${esc(t ? t.descricao : "")}</textarea></label>
  <div class="grid2"><label class="f">Responsável<select id="tf-resp">${opts}</select></label>
  <label class="f">Prazo (dia e hora)<input id="tf-prazo" type="datetime-local" value="${t && t.prazo ? (t.prazo.includes("T") ? t.prazo : t.prazo + "T18:00") : ""}"></label></div>
  ${S.d.funcionarios.length ? "" : `<p class="note">Cadastre a equipe na aba <b>Equipe</b> para escolher o responsável.</p>`}
  <div class="row"><button class="primary" data-act="tf-save" data-id="${t ? t.id : ""}" data-setor="${setorId}" data-pai="${paiId || ""}">${t ? "Salvar" : paiId ? "Criar subtarefa" : "Criar tarefa"}</button><button data-act="cancel">Cancelar</button></div></div>`;
}

function card(t) {
  if (S.editing === "task:" + t.id) return form(t, t.setor_id, t.parent_id);
  const e = estado(t), open = S.open.has(t.id), mine = !G() && t.resp_id === EU();
  const pill = { pend: ["", "A iniciar"], run: ["run", "Em andamento"], ok: ["ok", "Concluída"], late: ["late", "Atrasada"], "late-run": ["late", "Atrasada · em andamento"], bloq: ["bloq", "Aguardando"] }[e];
  const obs = S.d.obs.filter(o => o.tarefa_id === t.id), subs = t.parent_id ? [] : filhos(t.id);
  let h = `<article class="task ${open ? "open" : ""} ${mine ? "mine" : ""}"><div class="task-h" data-act="toggle" data-id="${t.id}">
  <div class="t"><div class="d">${esc(t.descricao)}</div><div class="meta"><span>👤 ${esc(nome(t.resp_id))}${mine ? " (você)" : ""}</span>
  <span class="${e.startsWith("late") ? "late-txt" : ""}">📅 ${fmtD(t.prazo)}</span>${obs.length ? `<span>💬 ${obs.length}</span>` : ""}${subs.length ? `<span>☑ ${subs.filter(x => x.fim).length}/${subs.length} subtarefas${!t.fim ? " esperando" : ""}</span>` : ""}</div></div>
  <span class="pill ${pill[0]}">${pill[1]}</span><span class="chev" aria-hidden="true">›</span></div>`;
  if (!open) return h + `</article>`;
  h += `<div class="task-b"><div class="times"><div><b>Início</b>${fmtDT(t.inicio)}</div><div><b>Fim</b>${fmtDT(t.fim)}</div></div>`;
  const p = pai(t), esperando = t.fim ? [] : filhos(t.id).filter(c => !c.fim);
  if (p && !p.fim) h += `<p class="wait">🔒 Libera quando <b>${esc(nome(p.resp_id))}</b> finalizar “${esc(p.descricao)}”.</p>`;
  if (!t.parent_id && esperando.length) h += `<p class="wait">⏳ ${esperando.length === 1 ? "1 subtarefa depende" : esperando.length + " subtarefas dependem"} desta: ${esc([...new Set(esperando.map(c => nome(c.resp_id)))].join(", "))}.</p>`;
  if (mine && bloqueada(t)) h += `<div class="row"><button class="big" disabled>🔒 Aguardando liberação</button></div>`;
  else if (mine && !t.inicio) h += `<div class="row"><button class="primary big" data-act="iniciar" data-id="${t.id}">▶ Iniciar tarefa</button></div>`;
  else if (mine && !t.fim) h += `<div class="row"><button class="primary big" data-act="finalizar" data-id="${t.id}">✔ Finalizar tarefa</button></div>`;
  if (G() && (t.inicio || t.fim)) h += `<div class="row">${confirmBtn("zerar", t.id, "Zerar início e fim")}</div>`;
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
  h += `</div>`;
  if (G() || mine) h += `<textarea id="ob-${t.id}" maxlength="1000" placeholder="${G() ? "Observação do gestor (ninguém apaga)" : "Escreva uma observação"}"></textarea><button class="primary" data-act="ob" data-id="${t.id}">Enviar observação</button>`;
  const avisos = [];
  if (G() && t.resp_id && !t.fim && !bloqueada(t)) { const l = zap(t.resp_id, `Olá ${nome(t.resp_id)}, você tem uma tarefa na decoração de Natal (${setorNome(t)}): ${t.descricao}.${t.prazo ? " Prazo: " + fmtD(t.prazo) + "." : ""} Veja no app: ${location.origin}`); if (l) avisos.push([l, `📲 Avisar ${nome(t.resp_id)} no WhatsApp`]); }
  if (t.fim && (G() || t.resp_id === EU())) filhos(t.id).filter(c => c.resp_id && !c.inicio).forEach(c => {
    const l = zap(c.resp_id, `${nome(c.resp_id)}, a tarefa "${t.descricao}" foi finalizada. Sua tarefa "${c.descricao}" está liberada. Veja no app: ${location.origin}`);
    if (l && !avisos.some(x => x[0] === l)) avisos.push([l, `📲 Avisar ${nome(c.resp_id)} que liberou`]); });
  if (avisos.length) h += `<div class="row">${avisos.map(([l, txt]) => `<a class="zap" href="${l}" target="_blank" rel="noopener">${esc(txt)}</a>`).join("")}</div>`;
  if (G()) h += `<div class="row"><button data-act="et" data-id="${t.id}">Editar</button>${confirmBtn("del-task", t.id, subs.length ? "Excluir com subtarefas" : "Excluir")}</div>`;
  if (!t.parent_id && (subs.length || G())) {
    h += `<p class="h3">Subtarefas</p><div class="list" style="margin-top:0">`;
    subs.forEach(c => h += card(c));
    if (G()) h += S.newTaskFor === "sub:" + t.id ? form(null, t.setor_id, t.id) : `<button data-act="nst" data-id="${t.id}">+ Subtarefa</button>`;
    h += `</div>`;
  }
  return h + `</div></article>`;
}

/* ---------- ações ---------- */
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
async function acao(method, url, body) {
  if (S.busy) return; S.busy = true;
  try { S.err = ""; await api(method, url, body); await carregar(); }
  catch (e) { S.err = e.message; draw(); }
  finally { S.busy = false; }
}
document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id ? Number(b.dataset.id) : null;
  if (act !== "ask") S.confirm = null;
  switch (act) {
    case "ver-novas": { const n = novas(); marcarVistas(n.map(t => t.id)); S.tab = "minhas"; n.forEach(t => { S.open.add(t.id); if (t.parent_id) S.open.add(t.parent_id); }); return draw(); }
    case "permitir": try { await Notification.requestPermission(); } catch (e) {} return draw();
    case "tab": S.tab = b.dataset.k; S.editing = null; return draw();
    case "toggle": S.open.has(id) ? S.open.delete(id) : S.open.add(id); return draw();
    case "toggle-setor": S.closed.has(id) ? S.closed.delete(id) : S.closed.add(id); return draw();
    case "cancel": S.editing = S.editingObs = S.newTaskFor = null; S.newSetor = false; return draw();
    case "ask": { const k = b.dataset.k + ":" + b.dataset.id; S.confirm = k; draw(); setTimeout(() => { if (S.confirm === k) { S.confirm = null; draw(); } }, 4000); return; }
    case "sair": S.chave = null; ls.set("chave", null); S.d = null; S.tab = null; S.entrarGestor = false; return draw();
    case "ir-gestor": S.entrarGestor = true; return draw();
    case "voltar": S.entrarGestor = false; return draw();
    case "login-g": try { const r = await api("POST", "/api/gestor", { senha: val("senha") }); S.chave = r.chave; ls.set("chave", r.chave); S.err = ""; S.entrarGestor = false; carregar(); } catch (e) { S.err = e.message; draw(); } return;
    case "login-f": try { const r = await api("POST", "/api/entrar", { telefone: val("tel") }); S.chave = r.chave; ls.set("chave", r.chave); S.err = ""; carregar(); } catch (e) { S.err = e.message; draw(); } return;
    case "ns": S.newSetor = true; draw(); window.scrollTo({ top: 0, behavior: "smooth" }); return;
    case "ns-save": { const n = val("ns-nome"); if (!n) return; S.newSetor = false; return acao("POST", "/api/setores", { nome: n }); }
    case "es": S.editing = "setor:" + id; return draw();
    case "es-save": { const n = val("es-nome"); if (!n) return; S.editing = null; return acao("PATCH", "/api/setores/" + id, { nome: n }); }
    case "del-setor": return acao("DELETE", "/api/setores/" + id);
    case "nst": S.newTaskFor = "sub:" + id; S.editing = null; return draw();
    case "nt": S.newTaskFor = id; S.editing = null; S.closed.delete(id); return draw();
    case "et": S.editing = "task:" + id; S.newTaskFor = null; return draw();
    case "tf-save": { const d = val("tf-desc"); if (!d) return document.getElementById("tf-desc").focus();
      const body = { setor_id: Number(b.dataset.setor), parent_id: b.dataset.pai ? Number(b.dataset.pai) : null, descricao: d, resp_id: val("tf-resp") || null, prazo: val("tf-prazo") || null };
      S.editing = null; S.newTaskFor = null;
      return id ? acao("PATCH", "/api/tarefas/" + id, body) : acao("POST", "/api/tarefas", body); }
    case "del-task": S.open.delete(id); return acao("DELETE", "/api/tarefas/" + id);
    case "iniciar": return acao("POST", `/api/tarefas/${id}/iniciar`);
    case "finalizar": return acao("POST", `/api/tarefas/${id}/finalizar`);
    case "zerar": return acao("POST", `/api/tarefas/${id}/zerar`);
    case "ob": { const el = document.getElementById("ob-" + id); const t = el ? el.value.trim() : ""; if (!t) return; el.value = ""; el.blur(); return acao("POST", `/api/tarefas/${id}/obs`, { texto: t }); }
    case "eo": S.editingObs = id; return draw();
    case "eo-save": { const t = val("eo-txt"); if (!t) return; S.editingObs = null; return acao("PATCH", "/api/obs/" + id, { texto: t }); }
    case "del-obs": return acao("DELETE", "/api/obs/" + id);
    case "nf-save": { const n = val("nf-nome"), t = val("nf-tel"); if (!n) return document.getElementById("nf-nome").focus(); if (!t) return document.getElementById("nf-tel").focus();
      await acao("POST", "/api/funcionarios", { nome: n, telefone: t }); if (!S.err) { const a = document.getElementById("nf-nome"), b2 = document.getElementById("nf-tel"); if (a) a.value = ""; if (b2) b2.value = ""; } return; }
    case "ef": S.editing = "func:" + id; return draw();
    case "ef-save": { const n = val("ef-nome"); if (!n) return; S.editing = null; return acao("PATCH", "/api/funcionarios/" + id, { nome: n, telefone: val("ef-tel") }); }
    case "del-func": return acao("DELETE", "/api/funcionarios/" + id);
    case "copiar": try { await navigator.clipboard.writeText(location.origin); b.textContent = "Copiado!"; } catch (e) { b.textContent = location.origin; } return;
  }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "senha") document.querySelector('[data-act="login-g"]').click();
  if (e.key === "Enter" && e.target.id === "tel") document.querySelector('[data-act="login-f"]').click(); });

/* ---------- atualização automática ---------- */
setInterval(() => { if (S.chave && !document.hidden && !S.busy) carregar(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) carregar(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (S.chave) carregar();
draw();
})();
