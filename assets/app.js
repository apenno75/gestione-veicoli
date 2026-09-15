/* =====================================================================
   Garage — logica dell'applicazione
   ===================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { CONFIG } from '../config.js';

/* ------------------------------ stato ------------------------------- */

const stato = {
  sessione: null,
  veicoli: [],
  scadenze: [],
  pagamenti: [],
  impostazioni: null,
  filtro: 'tutte',
  anno: 'tutti',
  veicoloFiltro: 'tutti',
};

const TIPI_NOTI = ['assicurazione', 'bollo', 'revisione'];

const ETICHETTE = {
  assicurazione: 'Assicurazione',
  bollo: 'Bollo',
  revisione: 'Revisione',
  tagliando: 'Tagliando',
  gomme: 'Gomme',
  batteria: 'Batteria',
  cinghia: 'Cinghia di distribuzione',
  bombole: 'Bombole gas',
  altro: 'Altro',
};

const RIPETIZIONI = {
  mensile: 'ogni mese',
  trimestrale: 'ogni tre mesi',
  semestrale: 'ogni sei mesi',
  annuale: 'ogni anno',
  biennale: 'ogni due anni',
  triennale: 'ogni tre anni',
  quadriennale: 'ogni quattro anni',
  nessuna: 'una volta sola',
};

let db = null;
let emailInAttesa = null;

/* ------------------------------ utilità ----------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function oggiISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function giorniA(iso) {
  if (!iso) return null;
  const [a, m, g] = iso.split('-').map(Number);
  const [a2, m2, g2] = oggiISO().split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, g) - Date.UTC(a2, m2 - 1, g2)) / 86400000);
}

function statoDi(giorni, preavviso = 7) {
  if (giorni === null) return 'neutro';
  if (giorni < 0) return 'rosso';
  if (giorni <= preavviso) return 'rosso';
  if (giorni <= 30) return 'ambra';
  return 'verde';
}

const fmtEuro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const fmtEuroTondo = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const euro = (n) => (n === null || n === undefined || n === '' ? '—' : fmtEuro.format(Number(n)));
const euroTondo = (n) => fmtEuroTondo.format(Number(n) || 0);

function dataIT(iso) {
  if (!iso) return '—';
  const [a, m, g] = iso.split('-');
  return `${g}/${m}/${a}`;
}

function dataLunga(iso) {
  if (!iso) return '—';
  const [a, m, g] = iso.split('-').map(Number);
  return new Date(a, m - 1, g).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
}

function nomeVeicolo(v) {
  if (!v) return 'Veicolo';
  return [v.marca, v.modello].filter(Boolean).join(' ');
}

function esc(testo) {
  return String(testo ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function avvisa(messaggio, tipo = 'ok') {
  const el = $('#avviso');
  el.textContent = messaggio;
  el.dataset.tipo = tipo;
  el.hidden = false;
  clearTimeout(avvisa._t);
  avvisa._t = setTimeout(() => { el.hidden = true; }, 4200);
}

function targaHTML(targa) {
  return `<span class="targa"><span class="targa-banda"><span class="targa-stelle">★★★</span>I</span><span class="targa-codice">${esc(targa || '—')}</span></span>`;
}

/* ------------------------------ avvio ------------------------------- */

function configurato() {
  return CONFIG.SUPABASE_URL.startsWith('https://')
    && !CONFIG.SUPABASE_URL.includes('xxxxx')
    && CONFIG.SUPABASE_ANON_KEY.length > 40;
}

async function avvia() {
  if (!configurato()) {
    $('#vista-config').hidden = false;
    return;
  }

  db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      // Evita il lock basato su navigator.locks: in certi browser può restare
      // "orfano" dopo una ricarica a metà operazione e bloccare per sempre
      // ogni chiamata successiva. Per un'app a singolo utente non serve.
      lock: async (_nome, _timeoutAcquisizione, fn) => fn(),
    },
  });

  const { data: { session } } = await db.auth.getSession();
  stato.sessione = session;

  db.auth.onAuthStateChange((_evento, sessione) => {
    const cambiato = (stato.sessione?.user?.id ?? null) !== (sessione?.user?.id ?? null);
    stato.sessione = sessione;
    if (cambiato) mostraVista();
  });

  collegaEventi();
  await mostraVista();
}

async function mostraVista() {
  const dentro = Boolean(stato.sessione);
  $('#vista-accesso').hidden = dentro;
  $('#vista-app').hidden = !dentro;
  if (!dentro) annullaCodice();
  if (dentro) await caricaDati();
}

/* ------------------------------ accesso ----------------------------- */

async function inviaLink(evento) {
  evento.preventDefault();
  const email = $('#accesso-email').value.trim();
  const esito = $('#accesso-esito');
  esito.dataset.tipo = '';
  esito.textContent = 'Invio in corso…';

  const { error } = await db.auth.signInWithOtp({ email });

  if (error) {
    esito.dataset.tipo = 'errore';
    esito.textContent = `Non è partito niente: ${error.message}`;
    return;
  }

  emailInAttesa = email;
  $('#form-accesso').hidden = true;
  $('#form-codice').hidden = false;
  $('#accesso-codice').value = '';
  $('#accesso-codice').focus();
  esito.dataset.tipo = '';
  esito.textContent = `Codice inviato a ${email}. Controlla la posta e scrivilo qui sotto.`;
}

async function verificaCodice(evento) {
  evento.preventDefault();
  const codice = $('#accesso-codice').value.trim();
  const esito = $('#accesso-esito');
  esito.dataset.tipo = '';
  esito.textContent = 'Verifica in corso…';

  try {
    const { error } = await db.auth.verifyOtp({
      email: emailInAttesa,
      token: codice,
      type: 'email',
    });

    if (error) {
      esito.dataset.tipo = 'errore';
      esito.textContent = `Codice non valido o scaduto: ${error.message}`;
    }
    // Se non c'è errore, onAuthStateChange mostra l'app da solo: nessun'altra azione qui.
  } catch (e) {
    esito.dataset.tipo = 'errore';
    esito.textContent = `Qualcosa è andato storto: ${e?.message ?? e}`;
  }
}

function annullaCodice() {
  emailInAttesa = null;
  $('#form-codice').hidden = true;
  $('#form-accesso').hidden = false;
  $('#accesso-esito').textContent = '';
}

/* ------------------------------ dati -------------------------------- */

async function caricaDati() {
  const uid = stato.sessione.user.id;

  const [veicoli, scadenze, pagamenti, impostazioni] = await Promise.all([
    db.from('veicoli').select('*').eq('attivo', true).order('tipo').order('modello'),
    db.from('scadenze').select('*, veicoli(id, marca, modello, targa, tipo)').eq('stato', 'aperta').order('data_scadenza'),
    db.from('pagamenti').select('*, veicoli(id, marca, modello, targa)').order('data_pagamento', { ascending: false }),
    db.from('impostazioni').select('*').eq('user_id', uid).maybeSingle(),
  ]);

  const errore = veicoli.error || scadenze.error || pagamenti.error || impostazioni.error;
  if (errore) {
    avvisa(`Lettura dei dati non riuscita: ${errore.message}`, 'errore');
    return;
  }

  stato.veicoli = veicoli.data ?? [];
  stato.scadenze = scadenze.data ?? [];
  stato.pagamenti = pagamenti.data ?? [];
  stato.impostazioni = impostazioni.data ?? {
    user_id: uid,
    email_promemoria: stato.sessione.user.email,
    giorni_preavviso: 7,
    invia_email: true,
  };

  disegna();
  controllaNotifiche();
}

const preavvisoDi = (s) => s.giorni_preavviso ?? stato.impostazioni?.giorni_preavviso ?? 7;

/* ------------------------------ disegno ----------------------------- */

function disegna() {
  disegnaSintesi();
  disegnaAgenda();
  disegnaVeicoli();
  preparaFiltriPagamenti();
  disegnaPagamenti();
}

function disegnaSintesi() {
  const aperte = [...stato.scadenze].sort((a, b) => a.data_scadenza.localeCompare(b.data_scadenza));
  const prossima = aperte[0];

  const elGiorni = $('#sintesi-giorni');
  if (!prossima) {
    elGiorni.textContent = '—';
    elGiorni.dataset.stato = 'neutro';
    $('#sintesi-cosa').textContent = 'Nessuna scadenza aperta';
  } else {
    const g = giorniA(prossima.data_scadenza);
    elGiorni.textContent = g < 0 ? `${Math.abs(g)} gg fa` : `${g} gg`;
    elGiorni.dataset.stato = statoDi(g, preavvisoDi(prossima));
    $('#sintesi-cosa').textContent =
      `${ETICHETTE[prossima.tipo] ?? prossima.tipo} · ${nomeVeicolo(prossima.veicoli)} · ${dataLunga(prossima.data_scadenza)}`;
  }

  const urgenti = aperte.filter((s) => giorniA(s.data_scadenza) <= preavvisoDi(s));
  $('#sintesi-urgenti').textContent = urgenti.length;
  $('#sintesi-urgenti').dataset.stato = urgenti.length ? 'rosso' : 'verde';

  const limite = new Date();
  limite.setFullYear(limite.getFullYear() + 1);
  const limiteISO = limite.toISOString().slice(0, 10);
  const previsto = aperte
    .filter((s) => s.data_scadenza <= limiteISO)
    .reduce((t, s) => t + Number(s.importo_previsto || 0), 0);
  $('#sintesi-previsto').textContent = euroTondo(previsto);

  const anno = new Date().getFullYear();
  $('#sintesi-anno').textContent = anno;
  const speso = stato.pagamenti
    .filter((p) => p.data_pagamento.startsWith(String(anno)))
    .reduce((t, p) => t + Number(p.importo || 0), 0);
  $('#sintesi-speso').textContent = euroTondo(speso);
}

function disegnaAgenda() {
  const lista = $('#agenda-lista');
  let voci = [...stato.scadenze].sort((a, b) => a.data_scadenza.localeCompare(b.data_scadenza));

  if (stato.filtro === 'altro') voci = voci.filter((s) => !TIPI_NOTI.includes(s.tipo));
  else if (stato.filtro !== 'tutte') voci = voci.filter((s) => s.tipo === stato.filtro);

  if (!voci.length) {
    lista.innerHTML = `<li class="vuoto">
      <p>${stato.scadenze.length ? 'Niente in questa categoria.' : 'Non c’è ancora nessuna scadenza.'}</p>
      ${stato.veicoli.length
        ? '<button class="btn btn-secondario" data-azione="nuova-scadenza">Aggiungi una scadenza</button>'
        : '<button class="btn btn-secondario" data-azione="nuovo-veicolo">Aggiungi il primo veicolo</button>'}
    </li>`;
    return;
  }

  lista.innerHTML = voci.map((s) => {
    const g = giorniA(s.data_scadenza);
    const st = statoDi(g, preavvisoDi(s));
    const testoGiorni = g < 0 ? Math.abs(g) : g;
    const unita = g < 0 ? 'giorni di ritardo' : (g === 1 ? 'giorno' : 'giorni');
    return `<li class="agenda-voce" data-stato="${st}">
      <div class="agenda-conto">
        <span class="agenda-numero">${testoGiorni}</span>
        <span class="agenda-unita">${unita}</span>
      </div>
      <div>
        <p class="agenda-titolo">${esc(ETICHETTE[s.tipo] ?? s.tipo)} — ${esc(nomeVeicolo(s.veicoli))}</p>
        <p class="agenda-sotto">
          ${dataLunga(s.data_scadenza)} · ${esc(s.veicoli?.targa ?? '')}
          ${s.fornitore ? ' · ' + esc(s.fornitore) : ''} · ${RIPETIZIONI[s.periodicita]}
        </p>
      </div>
      <div class="agenda-comandi">
        <span class="agenda-importo">${euro(s.importo_previsto)}</span>
        <button class="btn btn-secondario btn-minuto" data-azione="paga" data-id="${s.id}">Segna pagata</button>
        <button class="btn btn-fantasma btn-minuto" data-azione="modifica-scadenza" data-id="${s.id}">Modifica</button>
      </div>
    </li>`;
  }).join('');
}

function disegnaVeicoli() {
  const griglia = $('#griglia-veicoli');

  if (!stato.veicoli.length) {
    griglia.innerHTML = `<div class="vuoto">
      <p>Il garage è vuoto. Aggiungi un veicolo e poi le sue scadenze.</p>
      <button class="btn btn-secondario" data-azione="nuovo-veicolo">Aggiungi veicolo</button>
    </div>`;
    return;
  }

  griglia.innerHTML = stato.veicoli.map((v) => {
    const sue = stato.scadenze
      .filter((s) => s.veicolo_id === v.id)
      .sort((a, b) => a.data_scadenza.localeCompare(b.data_scadenza));

    const spesa = stato.pagamenti
      .filter((p) => p.veicolo_id === v.id)
      .reduce((t, p) => t + Number(p.importo || 0), 0);

    const dati = [
      v.data_immatricolazione ? `Immatricolata il ${dataIT(v.data_immatricolazione)}` : null,
      v.cv ? `${v.cv} CV` : null,
      v.kw ? `${String(v.kw).replace('.', ',')} kW` : null,
      v.pressione_gomme ? `gomme ${v.pressione_gomme}` : null,
    ].filter(Boolean).join(' · ');

    const righe = sue.length
      ? sue.map((s) => {
          const g = giorniA(s.data_scadenza);
          return `<li class="veicolo-scadenza">
            <span class="pallino" data-stato="${statoDi(g, preavvisoDi(s))}"></span>
            <span class="veicolo-scadenza-voce">${esc(ETICHETTE[s.tipo] ?? s.tipo)}</span>
            <span class="veicolo-scadenza-data">${dataIT(s.data_scadenza)}</span>
          </li>`;
        }).join('')
      : '<li class="veicolo-scadenza"><span class="agenda-sotto">Nessuna scadenza registrata.</span></li>';

    return `<article class="veicolo">
      <div class="veicolo-testa">
        <div>
          <h3 class="veicolo-nome">${esc(nomeVeicolo(v))}</h3>
          <span class="veicolo-tipo">${esc(v.tipo)}</span>
        </div>
        ${targaHTML(v.targa)}
      </div>
      ${dati ? `<p class="veicolo-dati">${esc(dati)}</p>` : ''}
      ${v.note ? `<p class="veicolo-dati">${esc(v.note)}</p>` : ''}
      <ul class="veicolo-scadenze">${righe}</ul>
      <p class="veicolo-dati">Speso finora: <strong>${euroTondo(spesa)}</strong></p>
      <div class="veicolo-azioni">
        <button class="btn btn-secondario btn-minuto" data-azione="nuova-scadenza" data-id="${v.id}">Aggiungi scadenza</button>
        <button class="btn btn-fantasma btn-minuto" data-azione="modifica-veicolo" data-id="${v.id}">Modifica</button>
      </div>
    </article>`;
  }).join('');
}

function preparaFiltriPagamenti() {
  const anni = [...new Set(stato.pagamenti.map((p) => p.data_pagamento.slice(0, 4)))].sort().reverse();
  const selAnno = $('#filtro-anno');
  selAnno.innerHTML = ['<option value="tutti">Tutti</option>', ...anni.map((a) => `<option value="${a}">${a}</option>`)].join('');
  selAnno.value = anni.includes(stato.anno) ? stato.anno : 'tutti';
  stato.anno = selAnno.value;

  const selVeicolo = $('#filtro-veicolo');
  selVeicolo.innerHTML = ['<option value="tutti">Tutti</option>',
    ...stato.veicoli.map((v) => `<option value="${v.id}">${esc(nomeVeicolo(v))}</option>`)].join('');
  selVeicolo.value = stato.veicoli.some((v) => v.id === stato.veicoloFiltro) ? stato.veicoloFiltro : 'tutti';
  stato.veicoloFiltro = selVeicolo.value;
}

function pagamentiFiltrati() {
  return stato.pagamenti.filter((p) => {
    if (stato.anno !== 'tutti' && !p.data_pagamento.startsWith(stato.anno)) return false;
    if (stato.veicoloFiltro !== 'tutti' && p.veicolo_id !== stato.veicoloFiltro) return false;
    return true;
  });
}

function disegnaPagamenti() {
  const righe = pagamentiFiltrati();
  const corpo = $('#corpo-pagamenti');

  if (!righe.length) {
    corpo.innerHTML = '<tr><td colspan="6">Nessuna spesa registrata per questa selezione.</td></tr>';
    $('#totale-pagamenti').textContent = euroTondo(0);
    return;
  }

  corpo.innerHTML = righe.map((p) => `<tr>
    <td>${dataIT(p.data_pagamento)}</td>
    <td>${esc(nomeVeicolo(p.veicoli))}</td>
    <td>${esc(ETICHETTE[p.tipo] ?? p.tipo)}</td>
    <td>${esc([p.metodo, p.riferimento, p.note].filter(Boolean).join(' · ')) || '—'}</td>
    <td class="num">${euro(p.importo)}</td>
    <td class="num"><button class="btn btn-fantasma btn-minuto" data-azione="elimina-pagamento" data-id="${p.id}">Elimina</button></td>
  </tr>`).join('');

  const totale = righe.reduce((t, p) => t + Number(p.importo || 0), 0);
  $('#totale-pagamenti').textContent = euroTondo(totale);
}

/* ------------------------------ finestre ---------------------------- */

function apriVeicolo(id = null) {
  const form = $('#form-veicolo');
  form.reset();
  const v = stato.veicoli.find((x) => x.id === id);
  $('#titolo-veicolo').textContent = v ? 'Modifica veicolo' : 'Nuovo veicolo';
  $('[data-azione="elimina-veicolo"]').hidden = !v;
  form.record_id.value = v?.id ?? '';
  if (v) {
    for (const campo of ['tipo', 'marca', 'modello', 'targa', 'data_immatricolazione', 'cv', 'kw', 'pressione_gomme', 'note']) {
      form[campo].value = v[campo] ?? '';
    }
  }
  $('#dlg-veicolo').showModal();
}

function apriScadenza(id = null, veicoloId = null) {
  const form = $('#form-scadenza');
  form.reset();
  const s = stato.scadenze.find((x) => x.id === id);
  $('#titolo-scadenza').textContent = s ? 'Modifica scadenza' : 'Nuova scadenza';
  $('[data-azione="elimina-scadenza"]').hidden = !s;
  form.record_id.value = s?.id ?? '';
  form.veicolo_id.value = s?.veicolo_id ?? veicoloId ?? stato.veicoli[0]?.id ?? '';
  form.giorni_preavviso.value = stato.impostazioni?.giorni_preavviso ?? 7;
  if (s) {
    for (const campo of ['tipo', 'periodicita', 'data_scadenza', 'importo_previsto', 'giorni_preavviso', 'fornitore', 'descrizione', 'note']) {
      form[campo].value = s[campo] ?? '';
    }
  }
  $('#dlg-scadenza').showModal();
}

function apriPagamento(scadenzaId) {
  const s = stato.scadenze.find((x) => x.id === scadenzaId);
  if (!s) return;
  const form = $('#form-pagamento');
  form.reset();
  form.scadenza_id.value = s.id;
  form.data_pagamento.value = oggiISO();
  form.importo.value = s.importo_previsto ?? '';
  $('#pagamento-contesto').textContent =
    `${ETICHETTE[s.tipo] ?? s.tipo} · ${nomeVeicolo(s.veicoli)} · scade il ${dataLunga(s.data_scadenza)}`;
  $('#pagamento-rinnovo').textContent = s.periodicita === 'nessuna'
    ? 'Questa voce non si ripete: una volta registrata sparisce dall’agenda.'
    : `Alla conferma creo già la prossima, ${RIPETIZIONI[s.periodicita]}.`;
  $('#dlg-pagamento').showModal();
}

function apriImpostazioni() {
  const form = $('#form-impostazioni');
  form.email_promemoria.value = stato.impostazioni?.email_promemoria ?? stato.sessione.user.email;
  form.giorni_preavviso.value = stato.impostazioni?.giorni_preavviso ?? 7;
  form.invia_email.checked = stato.impostazioni?.invia_email ?? true;
  $('#dlg-impostazioni').showModal();
}

/* ------------------------------ salvataggi -------------------------- */

function valoriForm(form, numerici = []) {
  const dati = Object.fromEntries(new FormData(form).entries());
  for (const chiave of Object.keys(dati)) {
    if (typeof dati[chiave] === 'string') dati[chiave] = dati[chiave].trim();
    if (dati[chiave] === '') dati[chiave] = null;
  }
  for (const n of numerici) if (dati[n] !== null && dati[n] !== undefined) dati[n] = Number(dati[n]);
  return dati;
}

async function salvaVeicolo(evento) {
  evento.preventDefault();
  const form = evento.target;
  const dati = valoriForm(form, ['cv', 'kw']);
  const id = dati.record_id;
  delete dati.record_id;
  dati.targa = dati.targa?.toUpperCase() ?? null;
  dati.user_id = stato.sessione.user.id;

  const q = id
    ? db.from('veicoli').update(dati).eq('id', id)
    : db.from('veicoli').insert(dati);

  const { error } = await q;
  if (error) return avvisa(`Salvataggio non riuscito: ${error.message}`, 'errore');

  $('#dlg-veicolo').close();
  avvisa(id ? 'Veicolo aggiornato.' : 'Veicolo aggiunto.');
  await caricaDati();
}

async function eliminaVeicolo() {
  const id = $('#form-veicolo').record_id.value;
  if (!id) return;
  const v = stato.veicoli.find((x) => x.id === id);
  if (!confirm(`Elimino ${nomeVeicolo(v)} con tutte le sue scadenze e spese? L’operazione non si annulla.`)) return;

  const { error } = await db.from('veicoli').delete().eq('id', id);
  if (error) return avvisa(`Eliminazione non riuscita: ${error.message}`, 'errore');

  $('#dlg-veicolo').close();
  avvisa('Veicolo eliminato.');
  await caricaDati();
}

async function salvaScadenza(evento) {
  evento.preventDefault();
  const form = evento.target;
  const dati = valoriForm(form, ['importo_previsto', 'giorni_preavviso']);
  const id = dati.record_id;
  delete dati.record_id;
  if (dati.giorni_preavviso === null) dati.giorni_preavviso = 7;
  dati.user_id = stato.sessione.user.id;
  dati.promemoria_inviato_il = null;

  if (!dati.veicolo_id) return avvisa('Scegli prima un veicolo.', 'errore');

  const q = id
    ? db.from('scadenze').update(dati).eq('id', id)
    : db.from('scadenze').insert(dati);

  const { error } = await q;
  if (error) return avvisa(`Salvataggio non riuscito: ${error.message}`, 'errore');

  $('#dlg-scadenza').close();
  avvisa(id ? 'Scadenza aggiornata.' : 'Scadenza aggiunta.');
  await caricaDati();
}

async function eliminaScadenza() {
  const id = $('#form-scadenza').record_id.value;
  if (!id) return;
  if (!confirm('Elimino questa scadenza? Le spese già registrate restano.')) return;

  const { error } = await db.from('scadenze').delete().eq('id', id);
  if (error) return avvisa(`Eliminazione non riuscita: ${error.message}`, 'errore');

  $('#dlg-scadenza').close();
  avvisa('Scadenza eliminata.');
  await caricaDati();
}

async function salvaPagamento(evento) {
  evento.preventDefault();
  const form = evento.target;
  const dati = valoriForm(form, ['importo']);

  const { error } = await db.rpc('registra_pagamento', {
    p_scadenza_id: dati.scadenza_id,
    p_importo: dati.importo,
    p_data: dati.data_pagamento,
    p_metodo: dati.metodo,
    p_riferimento: dati.riferimento,
    p_note: dati.note,
  });

  if (error) return avvisa(`Registrazione non riuscita: ${error.message}`, 'errore');

  $('#dlg-pagamento').close();
  avvisa('Pagamento registrato, prossima scadenza creata.');
  await caricaDati();
}

async function eliminaPagamento(id) {
  if (!confirm('Elimino questa spesa dallo storico?')) return;
  const { error } = await db.from('pagamenti').delete().eq('id', id);
  if (error) return avvisa(`Eliminazione non riuscita: ${error.message}`, 'errore');
  avvisa('Spesa eliminata.');
  await caricaDati();
}

async function salvaImpostazioni(evento) {
  evento.preventDefault();
  const form = evento.target;
  const dati = {
    user_id: stato.sessione.user.id,
    email_promemoria: form.email_promemoria.value.trim(),
    giorni_preavviso: Number(form.giorni_preavviso.value),
    invia_email: form.invia_email.checked,
    aggiornato_il: new Date().toISOString(),
  };

  const { error } = await db.from('impostazioni').upsert(dati, { onConflict: 'user_id' });
  if (error) return avvisa(`Salvataggio non riuscito: ${error.message}`, 'errore');

  $('#dlg-impostazioni').close();
  avvisa('Impostazioni salvate.');
  await caricaDati();
}

/* ------------------------- notifiche del browser -------------------- */

async function chiediNotifiche() {
  if (!('Notification' in window)) return avvisa('Questo browser non gestisce le notifiche.', 'errore');
  const esito = await Notification.requestPermission();
  avvisa(esito === 'granted'
    ? 'Avvisi attivi: te li mostro quando apri l’app.'
    : 'Avvisi non attivati. Puoi cambiarli nelle impostazioni del browser.');
}

function controllaNotifiche() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const chiave = `garage-avvisato-${oggiISO()}`;
  if (localStorage.getItem(chiave)) return;

  const urgenti = stato.scadenze.filter((s) => giorniA(s.data_scadenza) <= preavvisoDi(s));
  if (!urgenti.length) return;

  const prima = urgenti[0];
  const g = giorniA(prima.data_scadenza);
  const corpo = urgenti.length === 1
    ? `${ETICHETTE[prima.tipo]} ${nomeVeicolo(prima.veicoli)} — ${g < 0 ? `scaduta da ${Math.abs(g)} giorni` : `tra ${g} giorni`}`
    : `${urgenti.length} scadenze richiedono attenzione, la prima è ${ETICHETTE[prima.tipo]} ${nomeVeicolo(prima.veicoli)}.`;

  new Notification('Garage — scadenze in arrivo', { body: corpo, tag: 'garage-scadenze' });
  localStorage.setItem(chiave, '1');
}

/* ------------------------------ esporta ----------------------------- */

function esportaCSV() {
  const righe = [['tipo_riga', 'veicolo', 'targa', 'voce', 'data', 'importo', 'stato_o_note']];

  for (const s of stato.scadenze) {
    righe.push(['scadenza', nomeVeicolo(s.veicoli), s.veicoli?.targa ?? '', ETICHETTE[s.tipo] ?? s.tipo,
      s.data_scadenza, s.importo_previsto ?? '', s.note ?? '']);
  }
  for (const p of stato.pagamenti) {
    righe.push(['pagamento', nomeVeicolo(p.veicoli), p.veicoli?.targa ?? '', ETICHETTE[p.tipo] ?? p.tipo,
      p.data_pagamento, p.importo ?? '', [p.metodo, p.riferimento, p.note].filter(Boolean).join(' - ')]);
  }

  const csv = righe
    .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');

  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `garage-${oggiISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------ eventi ------------------------------ */

function collegaEventi() {
  $('#form-accesso').addEventListener('submit', inviaLink);
  $('#form-codice').addEventListener('submit', verificaCodice);
  $('#accesso-annulla').addEventListener('click', annullaCodice);
  $('#form-veicolo').addEventListener('submit', salvaVeicolo);
  $('#form-scadenza').addEventListener('submit', salvaScadenza);
  $('#form-pagamento').addEventListener('submit', salvaPagamento);
  $('#form-impostazioni').addEventListener('submit', salvaImpostazioni);

  $('#filtro-anno').addEventListener('change', (e) => { stato.anno = e.target.value; disegnaPagamenti(); });
  $('#filtro-veicolo').addEventListener('change', (e) => { stato.veicoloFiltro = e.target.value; disegnaPagamenti(); });

  document.addEventListener('click', async (e) => {
    const chiudi = e.target.closest('[data-chiudi]');
    if (chiudi) { chiudi.closest('dialog').close(); return; }

    const chip = e.target.closest('[data-filtro]');
    if (chip) {
      stato.filtro = chip.dataset.filtro;
      $$('.chip').forEach((c) => c.classList.toggle('chip-attivo', c === chip));
      disegnaAgenda();
      return;
    }

    const btn = e.target.closest('[data-azione]');
    if (!btn) return;
    const { azione, id } = btn.dataset;

    switch (azione) {
      case 'nuovo-veicolo': apriVeicolo(); break;
      case 'modifica-veicolo': apriVeicolo(id); break;
      case 'elimina-veicolo': await eliminaVeicolo(); break;
      case 'nuova-scadenza': apriScadenza(null, id); break;
      case 'modifica-scadenza': apriScadenza(id); break;
      case 'elimina-scadenza': await eliminaScadenza(); break;
      case 'paga': apriPagamento(id); break;
      case 'elimina-pagamento': await eliminaPagamento(id); break;
      case 'impostazioni': apriImpostazioni(); break;
      case 'chiedi-notifiche': await chiediNotifiche(); break;
      case 'esporta': esportaCSV(); break;
      case 'esci': await db.auth.signOut(); break;
    }
  });
}

avvia();
