// ==UserScript==
// @name         SMAX Global - TJSP
// @namespace    https://github.com/rsalvessap/SMAX-Global
// @version      1.5
// @description  Abertura automatizada de chamado global no SMAX TJSP — aprende o molde a partir de uma abertura manual e replica trocando titulo, descricao, urgencia e solicitante
// @author       rsalvessap
// @match        https://suporte.tjsp.jus.br/saw/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @noframes
// @downloadURL  https://github.com/rsalvessap/SMAX-Global/raw/refs/heads/master/SMAX/SMAX%20Global%20-%20TJSP.user.js
// @updateURL    https://github.com/rsalvessap/SMAX-Global/raw/refs/heads/master/SMAX/SMAX%20Global%20-%20TJSP.user.js
// @homepageURL  https://github.com/rsalvessap/SMAX-Global
// @supportURL   https://github.com/rsalvessap/SMAX-Global/issues
// ==/UserScript==

(function () {
  'use strict';

  if (window.top && window.top !== window.self) return;
  if (window.location.hostname !== 'suporte.tjsp.jus.br') return;

  const SMAX_GLOBAL_VERSION = '1.5';

  // O userscript roda em sandbox; quem dispara as requisicoes e a pagina.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* =========================================================
   * Store
   * =======================================================*/
  const Store = (() => {
    const KEY = 'smax_global_prefs';
    const defaults = {
      themeMode: 'dark',
      enableRealWrites: true,
      // Molde unico aprendido a partir de uma abertura manual
      molde: null,          // { capturedAt, url, method, properties, sampleResponse }
      // "E Global" e marcado DEPOIS de salvar, na aba Classificacao. Sem esse
      // segundo passo o replay gera um chamado comum, nao um global.
      moldeGlobal: null,
      lastTitle: '',
      lastUrgency: 'med',
      // O SMAX recarrega a pagina ao navegar ate a tela de abertura, entao o
      // modo aprender e as capturas precisam sobreviver a um reload.
      learning: false,
      // Modo seco: captura o payload e CANCELA a requisicao, para aprender o
      // molde sem abrir chamado de verdade. Padrao ligado — aprender nao
      // deveria custar um chamado em producao.
      learnDryRun: true,
      candidates: [],
      sniffer: [],          // tudo que passou pelo interceptador e NAO virou candidato
      // Cache Id -> Name de pessoas. O molde guarda so o Id do solicitante; sem
      // isso o painel mostraria um numero ate a busca remota responder, a cada
      // reload do SMAX.
      personNames: {},
      // Solucao de contorno. No SMAX ela nao e um campo do Request: e uma
      // DISCUSSAO com FunctionalPurpose 'SolucaoContorno_c'. Por isso nao precisa
      // de molde capturado — o payload e conhecido.
      // O texto e um padrao da equipe, editavel a cada abertura; so o botao
      // "salvar como padrao" persiste uma alteracao.
      contornoPadrao: '',
      contornoTo: 'Agent',
      contornoPurpose: 'SolucaoContorno_c',
    };

    const state = JSON.parse(JSON.stringify(defaults));

    const load = () => {
      try {
        const saved = GM_getValue(KEY);
        if (!saved) return;
        Object.assign(state, defaults, JSON.parse(saved) || {});
      } catch (err) {
        console.warn('[SMAX Global] Falha ao carregar preferencias:', err);
      }
    };

    const save = () => {
      try {
        GM_setValue(KEY, JSON.stringify(state));
      } catch (err) {
        console.warn('[SMAX Global] Falha ao salvar preferencias:', err);
      }
    };

    load();
    return { state, save };
  })();

  const prefs = Store.state;

  /* =========================================================
   * Utils
   * =======================================================*/
  const Utils = (() => {
    const SAFE_TAGS = new Set([
      'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'span',
      'ul', 'ol', 'li', 'a', 'img', 'hr', 'h1', 'h2', 'h3', 'h4', 'blockquote',
      'table', 'thead', 'tbody', 'tr', 'td', 'th', 'font', 'sub', 'sup', 'pre', 'code'
    ]);

    const escapeHtml = (value) => {
      if (value == null) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    const sanitizeRichText = (html) => {
      if (!html) return '';
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('script, style, iframe, object, embed, form, input, textarea, select, button, svg, math, template, link, meta, base, noscript').forEach(el => el.remove());
      tmp.querySelectorAll('*').forEach((node) => {
        if (!SAFE_TAGS.has(node.tagName.toLowerCase())) {
          node.replaceWith(...node.childNodes);
          return;
        }
        Array.from(node.attributes || []).forEach((attr) => {
          const name = attr.name.toLowerCase();
          if (/^on/i.test(name)) { node.removeAttribute(attr.name); return; }
          if (['href', 'src', 'action', 'xlink:href', 'formaction'].includes(name)) {
            const val = (attr.value || '').replace(/[\s\u0000-\u001F]+/g, '').toLowerCase();
            if (/^(javascript|vbscript)\s*:/i.test(val)) { node.removeAttribute(attr.name); return; }
            if (/^data\s*:/i.test(val) && !/^data\s*:\s*image\//i.test(val)) { node.removeAttribute(attr.name); }
          }
        });
      });
      return tmp.innerHTML;
    };

    // Achata <div>/<p> em <br> e remove markup do Office. O SMAX trunca rich-text
    // grande convertendo em link server-side, entao o HTML enviado tem que ser enxuto.
    const normalizeContentEditableHtml = (html) => {
      if (!html) return '';
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('o\\:p, xml, style, meta, link, title, head').forEach(el => el.remove());
      tmp.querySelectorAll('*').forEach(el => {
        el.removeAttribute('class');
        el.removeAttribute('data-mce-style');
        el.removeAttribute('data-mce-fragment');
        if (el.tagName.toLowerCase() !== 'img') el.removeAttribute('style');
      });
      Array.from(tmp.querySelectorAll('div, p')).reverse().forEach(block => {
        const br = document.createElement('br');
        block.parentNode.insertBefore(br, block);
        while (block.firstChild) block.parentNode.insertBefore(block.firstChild, block);
        block.remove();
      });
      return sanitizeRichText(tmp.innerHTML)
        .replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>')
        .replace(/^(\s*<br\s*\/?>)+/i, '')
        .trim();
    };

    const htmlToText = (html) => {
      const tmp = document.createElement('div');
      tmp.innerHTML = html || '';
      return (tmp.textContent || '').replace(/\u00a0/g, ' ').trim();
    };

    const deepClone = (value) => {
      if (Array.isArray(value)) return value.map(deepClone);
      if (value && typeof value === 'object') {
        return Object.entries(value).reduce((acc, [k, v]) => { acc[k] = deepClone(v); return acc; }, {});
      }
      return value;
    };

    const onDomReady = (fn) => {
      if (typeof fn !== 'function') return;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn, { once: true });
      } else {
        fn();
      }
    };

    const formatBrDateTime = (ts) => {
      if (!ts) return '—';
      try {
        return new Date(ts).toLocaleString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
      } catch { return '—'; }
    };

    return { escapeHtml, sanitizeRichText, normalizeContentEditableHtml, htmlToText, deepClone, onDomReady, formatBrDateTime };
  })();

  /* =========================================================
   * ApiClient  (portado do SMAX Respostas)
   * =======================================================*/
  const ApiClient = (() => {
    let cachedTenantId = null;

    const readCookie = (key) => {
      if (!key) return null;
      const match = document.cookie.match(new RegExp(`${key}=([^;]+)`));
      return match ? decodeURIComponent(match[1]) : null;
    };

    const pickTenantFromUrl = () => {
      try {
        const search = new URLSearchParams(window.location.search || '');
        return search.get('tenantid') || search.get('TENANTID');
      } catch { return null; }
    };

    const pickTenantFromHash = () => {
      const match = (window.location.hash || '').match(/tenantid=(\d+)/i);
      return match ? match[1] : null;
    };

    const pickTenantFromStorage = () => {
      try {
        return sessionStorage.getItem('smaxTenantId') || localStorage.getItem('smaxTenantId');
      } catch { return null; }
    };

    const resolveTenantId = () => {
      if (cachedTenantId) return cachedTenantId;
      const explicit = window.SMAX_TENANT_ID || window.globalTenantId;
      cachedTenantId = (explicit || pickTenantFromUrl() || pickTenantFromHash() || readCookie('TENANTID') || pickTenantFromStorage() || '').trim();
      return cachedTenantId || null;
    };

    const getTenantId = () => resolveTenantId();

    const restBase = () => {
      const tenantId = getTenantId();
      return tenantId ? `/rest/${tenantId}` : '/rest';
    };

    const normalizePath = (path = '') => {
      if (!path) return restBase();
      if (/^https?:\/\//i.test(path)) return path;
      if (path.startsWith('/rest/')) return path;
      return `${restBase()}/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '');
    };

    const buildUrl = (path, { searchParams, includeTenantParam } = {}) => {
      const url = new URL(normalizePath(path), window.location.origin);
      if (searchParams) {
        const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);
        params.forEach((value, key) => url.searchParams.set(key, value));
      }
      if (includeTenantParam) {
        const tenantId = getTenantId();
        if (tenantId) url.searchParams.set('TENANTID', tenantId);
      }
      return url.toString().replace(/\+/g, '%20');
    };

    const request = async (path, options = {}) => {
      const {
        method = 'GET', headers = {}, body, searchParams,
        includeTenantParam = false, useXsrf = false, expectJson = true, timeout = 30000
      } = options;

      const finalHeaders = {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        ...headers
      };
      if (useXsrf) {
        const token = readCookie('XSRF-TOKEN');
        if (token) finalHeaders['X-XSRF-TOKEN'] = token;
      }

      let payload = body;
      if (body && typeof body === 'object' && !(body instanceof FormData)) {
        if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json;charset=utf-8';
        payload = JSON.stringify(body);
      }

      const controller = timeout ? new AbortController() : null;
      const abortTimer = controller ? setTimeout(() => controller.abort(), timeout) : null;

      const response = await fetch(buildUrl(path, { searchParams, includeTenantParam }), {
        method,
        headers: finalHeaders,
        body: payload,
        credentials: 'include',
        signal: controller ? controller.signal : undefined
      });
      if (abortTimer) clearTimeout(abortTimer);

      if (!response.ok) {
        let errBody = '';
        try { errBody = await response.text(); } catch { }
        if (errBody) console.warn(`[SMAX Global] HTTP ${response.status} body:`, errBody.slice(0, 800));
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        err.body = errBody;
        throw err;
      }
      if (!expectJson) return response.text();
      const text = await response.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    };

    return { getTenantId, request };
  })();

  /* =========================================================
   * People — busca de pessoas para o campo "Solicitado para".
   *
   * O SMAX rejeita LIKE/% na entidade Person, entao a busca e por
   * range de prefixo: Name >= 'TERMO' and Name < 'TERMP'.
   * =======================================================*/
  const People = (() => {
    // Os solicitantes validos para global comecam todos com isso (regra da equipe),
    // entao o picker ja abre com os quatro na tela, sem digitar nada.
    const SEED_TERM = 'GLOBAL EPROC';
    const LAYOUT = 'Name,Upn,Email,FirstName,LastName,Title';

    const toPeople = (payload) => (payload?.entities || [])
      .filter(e => e?.entity_type === 'Person')
      .map(e => {
        const p = e.properties || {};
        return {
          id: p.Id != null ? String(p.Id) : '',
          name: String(p.Name || '').trim(),
          upn: String(p.Upn || '').trim()
        };
      })
      .filter(p => p.id && p.name);

    const remember = (people) => {
      let changed = false;
      people.forEach(p => {
        if (prefs.personNames[p.id] !== p.name) { prefs.personNames[p.id] = p.name; changed = true; }
      });
      if (changed) Store.save();
    };

    const search = async (term) => {
      const q = String(term || '').trim().replace(/'/g, "''");
      if (q.length < 3) return [];
      const upper = q.toUpperCase();
      const upperBound = upper.slice(0, -1)
        + String.fromCharCode(upper.charCodeAt(upper.length - 1) + 1);
      const payload = await ApiClient.request('ems/Person', {
        method: 'GET',
        searchParams: {
          filter: `Name >= '${upper}' and Name < '${upperBound}'`,
          layout: LAYOUT,
          size: '30',
          skip: '0',
          order: 'Name asc'
        },
        includeTenantParam: true
      });
      const people = toPeople(payload);
      remember(people);
      return people;
    };

    // Resolve o nome do solicitante que veio congelado no molde (que guarda so o Id).
    const nameFor = (id) => prefs.personNames[String(id || '')] || '';

    const resolveName = async (id) => {
      const key = String(id || '').trim();
      // Filtro vai concatenado na query — so aceita Id numerico.
      if (!/^\d+$/.test(key)) return '';
      if (prefs.personNames[key]) return prefs.personNames[key];
      const payload = await ApiClient.request('ems/Person', {
        method: 'GET',
        searchParams: { filter: `Id = '${key}'`, layout: LAYOUT, size: '1', skip: '0' },
        includeTenantParam: true
      });
      const people = toPeople(payload);
      remember(people);
      return people[0]?.name || '';
    };

    return { SEED_TERM, search, nameFor, resolveName };
  })();

  /* =========================================================
   * Capture — grava o payload REAL que a UI nativa envia ao criar
   * um Request, para ser usado como molde.
   *
   * Diferente do Network patch dos outros scripts (que le RESPOSTAS
   * para alimentar cache), aqui o que interessa e o CORPO DA REQUISICAO.
   * =======================================================*/
  const Capture = (() => {
    const RE_REST = /\/rest\/\d+\//i;
    const MAX_CANDIDATES = 40;

    const MAX_SNIFFER = 25;
    const MAX_PERSISTED = 8;

    let patched = false;
    const listeners = new Set();

    // Estado vem do storage: arming e capturas precisam sobreviver ao reload
    // que o SMAX faz ao navegar ate a tela de abertura de chamado.
    let armed = !!prefs.learning;
    let dryRun = prefs.learnDryRun !== false;
    const candidates = Array.isArray(prefs.candidates) ? prefs.candidates.slice() : [];
    const sniffer = Array.isArray(prefs.sniffer) ? prefs.sniffer.slice() : [];

    const notify = () => listeners.forEach(fn => { try { fn(); } catch { } });

    const persist = () => {
      prefs.learning = armed;
      prefs.learnDryRun = dryRun;
      prefs.candidates = candidates.slice(0, MAX_PERSISTED);
      prefs.sniffer = sniffer.slice(0, MAX_SNIFFER);
      Store.save();
    };

    const parseBody = (body) => {
      if (!body || typeof body !== 'string') return null;
      try { return JSON.parse(body); } catch { return null; }
    };

    // O corpo nem sempre chega como string: pode ser URLSearchParams, Blob,
    // ArrayBuffer ou um Request. Sem isso a captura falha em silencio.
    const bodyToString = (body) => {
      if (body == null) return null;
      if (typeof body === 'string') return body;
      try {
        if (body instanceof URLSearchParams) return body.toString();
        if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
          return new TextDecoder('utf-8').decode(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
        }
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
          return JSON.stringify(Object.fromEntries([...body.entries()].map(([k, v]) => [k, String(v)])));
        }
      } catch { }
      return null;
    };

    const describeBody = (body, raw) => {
      if (raw) return raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
      if (body == null) return '(sem corpo)';
      const t = Object.prototype.toString.call(body);
      return `(corpo nao textual: ${t})`;
    };

    // Registra TUDO que passou pelo interceptador mas nao virou candidato.
    // Sem isso, quando o payload do SMAX nao bate com a heuristica, o usuario
    // ve o painel vazio e nao tem como saber o porque.
    const sniff = ({ method, url, body, raw, reason }) => {
      sniffer.unshift({
        t: Date.now(),
        method: String(method || '').toUpperCase(),
        url: String(url || ''),
        reason,
        preview: describeBody(body, raw)
      });
      if (sniffer.length > MAX_SNIFFER) sniffer.length = MAX_SNIFFER;
      persist();
      notify();
    };

    // Um payload serve como molde se cria uma entidade Request.
    const scoreCandidate = (json) => {
      if (!json || typeof json !== 'object') return 0;
      const op = String(json.operation || '').toUpperCase();
      const entities = Array.isArray(json.entities) ? json.entities : [];
      const hasRequest = entities.some(e => String(e?.entity_type || '') === 'Request');
      if (op === 'CREATE' && hasRequest) return 100;
      if (op === 'CREATE' && entities.length) return 40;
      if (hasRequest) return 10;
      return 0;
    };

    // Decide se um corpo vira molde SEM depender da resposta. E o que permite o
    // modo seco: avaliar antes de a requisicao sair do navegador.
    const evaluate = ({ method, url, body }) => {
      if (String(method || '').toUpperCase() === 'GET') return { skip: true };
      const raw = bodyToString(body);
      if (!RE_REST.test(url)) return { raw, reason: 'URL fora de /rest/{tenant}/' };
      const json = parseBody(raw);
      if (!json) return { raw, reason: 'corpo nao e JSON' };
      const score = scoreCandidate(json);
      if (!score) return { raw, reason: 'JSON sem CREATE de Request' };
      return { raw, json, score };
    };

    const pushCandidate = ({ method, url, json, score, responseText, blocked }) => {
      candidates.unshift({
        capturedAt: Date.now(),
        method: String(method || '').toUpperCase(),
        url,
        score,
        blocked: !!blocked,
        body: json,
        response: parseBody(responseText)
      });
      if (candidates.length > MAX_CANDIDATES) candidates.length = MAX_CANDIDATES;
      console.info('[SMAX Global] Candidato capturado (score %d%s): %s', score, blocked ? ', modo seco' : '', url);
      persist();
      notify();
    };

    const record = ({ method, url, body, responseText }) => {
      if (!armed) return;
      const ev = evaluate({ method, url, body });
      if (ev.skip) return;
      if (!ev.json) { sniff({ method, url, body, raw: ev.raw, reason: ev.reason }); return; }
      pushCandidate({ method, url, json: ev.json, score: ev.score, responseText });
    };

    // Modo seco: captura e devolve true para o chamador CANCELAR o envio.
    // O erro de salvamento que o SMAX mostra e a prova de que nada foi criado.
    const interceptBeforeSend = ({ method, url, body }) => {
      if (!armed || !dryRun) return false;
      const ev = evaluate({ method, url, body });
      if (ev.skip) return false;
      if (!ev.json) { sniff({ method, url, body, raw: ev.raw, reason: ev.reason }); return false; }
      pushCandidate({ method, url, json: ev.json, score: ev.score, blocked: true });
      console.warn('[SMAX Global] MODO SECO — requisição capturada e CANCELADA, nada foi salvo:', url);
      return true;
    };

    // readyState e somente leitura, entao nao da para forjar uma resposta: o que
    // se dispara e o evento de erro, igual a uma queda de rede. Se a tela do SMAX
    // ficar girando em vez de acusar erro, basta recarregar — nada saiu daqui.
    const failLocally = (xhr) => {
      setTimeout(() => {
        try {
          const mk = (type) => (typeof ProgressEvent === 'function' ? new ProgressEvent(type) : new Event(type));
          xhr.dispatchEvent(mk('error'));
          xhr.dispatchEvent(mk('loadend'));
        } catch (err) {
          console.warn('[SMAX Global] Falha ao sinalizar erro do XHR seco:', err);
        }
      }, 0);
    };

    const patch = () => {
      if (patched) return;
      patched = true;
      try {
        const XHR = (pageWindow && pageWindow.XMLHttpRequest) || XMLHttpRequest;
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;

        XHR.prototype.open = function patchedOpen(method, url, ...rest) {
          try { this.__smaxGlobalUrl = url; this.__smaxGlobalMethod = method; } catch { }
          return origOpen.call(this, method, url, ...rest);
        };

        XHR.prototype.send = function patchedSend(body) {
          const reqBody = body;
          const method = this.__smaxGlobalMethod;
          const url = this.__smaxGlobalUrl || '';

          try {
            if (interceptBeforeSend({ method, url, body: reqBody })) {
              failLocally(this);
              return;   // a requisicao nao chega a existir
            }
          } catch (err) {
            // Se a avaliacao falhar, deixa seguir: bloquear por engano e pior
            // do que perder uma captura.
            console.warn('[SMAX Global] Falha ao avaliar XHR no modo seco:', err);
          }

          // No modo seco os nao-candidatos ja foram para o diagnostico acima;
          // registrar de novo na resposta duplicaria tudo.
          if (armed && !dryRun) {
            this.addEventListener('load', function onLoad() {
              try {
                record({
                  method: this.__smaxGlobalMethod,
                  url: this.__smaxGlobalUrl || this.responseURL || '',
                  body: reqBody,
                  responseText: this.responseText
                });
              } catch { }
            });
          }
          return origSend.call(this, body);
        };

        const fetchHost = pageWindow && pageWindow.fetch ? pageWindow : window;
        if (fetchHost.fetch) {
          const origFetch = fetchHost.fetch;
          fetchHost.fetch = function patchedFetch(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';
            // Quando o corpo vem dentro de um Request, so da para ler clonando.
            let bodyPromise;
            if (init && init.body != null) bodyPromise = Promise.resolve(init.body);
            else if (input && typeof input === 'object' && typeof input.clone === 'function') {
              bodyPromise = input.clone().text().catch(() => null);
            } else bodyPromise = Promise.resolve(null);

            // Modo seco: precisa do corpo ANTES de enviar. Quando ele vem dentro
            // de um Request so da para ler de forma assincrona, entao aqui o
            // fetch vira async um passo antes — so enquanto aprendendo.
            if (armed && dryRun && String(method).toUpperCase() !== 'GET') {
              const self = this;
              return bodyPromise.then((reqBody) => {
                let blocked = false;
                try {
                  blocked = interceptBeforeSend({ method, url, body: reqBody });
                } catch (err) {
                  console.warn('[SMAX Global] Falha ao avaliar fetch no modo seco:', err);
                }
                // Mesma falha que o navegador daria sem rede.
                if (blocked) return Promise.reject(new TypeError('Failed to fetch'));
                return origFetch.call(self, input, init);
              });
            }

            return origFetch.call(this, input, init).then((resp) => {
              try {
                if (armed && String(method).toUpperCase() !== 'GET') {
                  Promise.all([bodyPromise, resp.clone().text().catch(() => '')])
                    .then(([reqBody, txt]) => {
                      record({ method, url: url || resp.url, body: reqBody, responseText: txt });
                    }).catch(() => { });
                }
              } catch { }
              return resp;
            });
          };
        }
      } catch (err) {
        console.warn('[SMAX Global] Falha ao instalar interceptador:', err);
      }
    };

    return {
      patch,
      arm: () => { armed = true; persist(); notify(); },
      disarm: () => { armed = false; persist(); notify(); },
      isArmed: () => armed,
      isDryRun: () => dryRun,
      setDryRun: (v) => { dryRun = !!v; persist(); notify(); },
      getCandidates: () => candidates.slice(),
      getSniffer: () => sniffer.slice(),
      clear: () => { candidates.length = 0; sniffer.length = 0; persist(); notify(); },
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
    };
  })();

  // Precisa rodar antes de qualquer requisicao do SMAX.
  Capture.patch();

  /* =========================================================
   * Molde — normalizacao e replay
   * =======================================================*/
  const Molde = (() => {
    // Campos que NAO podem ser reaproveitados de uma criacao anterior.
    const STRIP_KEYS = ['Id', 'LastUpdateTime', 'CreateTime', 'UpdateTime', 'Comments'];

    const URGENCY_PRESETS = {
      low:  { label: 'Baixa',    props: { Urgency: 'NoDisruption',       ImpactScope: 'SingleUser' } },
      med:  { label: 'Média',    props: { Urgency: 'SlightDisruption',   ImpactScope: 'SiteOrDepartment' } },
      high: { label: 'Alta',     props: { Urgency: 'TotalLossOfService', ImpactScope: 'SiteOrDepartment' } },
      crit: { label: 'Crítica',  props: { Urgency: 'TotalLossOfService', ImpactScope: 'Enterprise' } },
    };

    // O molde guarda o corpo INTEIRO que a UI nativa enviou, nao so as properties.
    // Assim qualquer campo irmao que o SMAX espere (relationships, flags, etc.)
    // viaja junto no replay em vez de ser descartado.
    const fromCandidate = (candidate) => {
      const entities = candidate.body.entities || [];
      const idx = entities.findIndex(e => String(e?.entity_type || '') === 'Request');
      if (idx < 0) return null;
      return {
        capturedAt: candidate.capturedAt,
        // Caminho relativo: o tenant e reinjetado no replay, caso mude de sessao.
        path: String(candidate.url).replace(/^.*\/rest\/\d+\//i, ''),
        method: candidate.method,
        body: Utils.deepClone(candidate.body),
        entityIndex: idx,
        sampleResponse: candidate.response || null
      };
    };

    const getProperties = (molde) => (molde?.body?.entities?.[molde.entityIndex]?.properties) || {};

    // "Solicitado para" no SMAX e RequestedForPerson. RequestedByPerson (quem
    // registrou) fica como esta no molde — nao e o campo que a equipe troca.
    const REQUESTER_KEY = 'RequestedForPerson';

    const getRequesterId = (molde) => String(getProperties(molde)[REQUESTER_KEY] || '').trim();

    const buildPayload = (molde, { title, descriptionHtml, urgency, requesterId }) => {
      const payload = Utils.deepClone(molde.body);
      const props = payload.entities[molde.entityIndex].properties || {};
      STRIP_KEYS.forEach(k => delete props[k]);
      if (title) props.DisplayLabel = title;
      if (descriptionHtml) props.Description = descriptionHtml;
      if (requesterId) props[REQUESTER_KEY] = String(requesterId);
      const preset = URGENCY_PRESETS[urgency];
      if (preset) Object.assign(props, preset.props);
      payload.entities[molde.entityIndex].properties = props;
      return payload;
    };

    // Passo 2: replica o UPDATE que marcou "E Global", apontando para o chamado
    // recem-criado. Nao precisamos saber o nome do campo — ele viaja no molde.
    const buildGlobalFlagPayload = (moldeGlobal, newId) => {
      const payload = Utils.deepClone(moldeGlobal.body);
      const props = payload.entities[moldeGlobal.entityIndex].properties || {};
      ['LastUpdateTime', 'CreateTime', 'UpdateTime', 'Comments'].forEach(k => delete props[k]);
      props.Id = newId;
      payload.entities[moldeGlobal.entityIndex].properties = props;
      return payload;
    };

    const extractCreatedId = (res) => {
      if (!res || typeof res !== 'object') return '';
      const lists = [res.entity_result_list, res.entities, res.entity_list].filter(Array.isArray);
      for (const list of lists) {
        for (const item of list) {
          const p = item?.entity?.properties || item?.properties || {};
          const id = String(p.Id || '').replace(/^IM(Rfc|chg):/i, '').trim();
          if (id) return id;
        }
      }
      return '';
    };

    const completionStatus = (res) => String(res?.meta?.completion_status || '').toUpperCase();

    return { STRIP_KEYS, URGENCY_PRESETS, REQUESTER_KEY, fromCandidate, getProperties, getRequesterId, buildPayload, buildGlobalFlagPayload, extractCreatedId, completionStatus };
  })();

  /* =========================================================
   * Discussion — comentario no Request.
   *
   * A "solucao de contorno" do procedimento da equipe NAO e um campo do Request:
   * e uma discussao com FunctionalPurpose 'SolucaoContorno_c'. Por isso esta parte
   * nao usa molde capturado — o payload e conhecido e estavel.
   *
   * Portado do SMAX Respostas ADM (postDiscussion), que ja roda em producao.
   * =======================================================*/
  const Discussion = (() => {
    // "Para" define quem ve o comentario. So 'User' e publico; o resto e interno.
    const TO_OPTIONS = [
      ['Agent',               '→ Agente'],
      ['User',                '→ Usuário'],
      ['Vendor',              '→ Fornecedor'],
      ['ExternalServiceDesk', '→ Central Externa'],
      ['Stakeholder',         '→ Participantes'],
    ];

    const PURPOSE_OPTIONS = [
      ['SolucaoContorno_c',       'Solução de Contorno'],
      ['StatusUpdate',            'Atualização de status'],
      ['FollowUp',                'Acompanhamento'],
      ['Resolution',              'Resolução'],
      ['ResolutionActivity',      'Atividade de resolução'],
      ['RequestMoreInformation',  'Solicitar mais informações'],
      ['ProvideInformation',      'Fornecer informações'],
      ['EndUserComment',          'Comentário do usuário'],
      ['Diagnosis',               'Diagnóstico'],
      ['SCCDComment_c',           'Comentário para SCCD'],
      ['Fornecedor_c',           'Comentário para Fornecedor'],
    ];

    const randomCommentId = () => {
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    };

    // O SMAX nao aceita "acrescentar" um comentario: o campo Comments e reescrito
    // inteiro. Num global recem-criado a lista esta vazia, entao aqui ela comeca
    // vazia — este script so comenta em chamado que ele mesmo acabou de abrir.
    const buildPayload = ({ ticketId, bodyHtml, commentTo, purposeCode, submitterId = '' }) => {
      const comment = {
        CommentId: randomCommentId(),
        Submitter: submitterId ? `Person/${submitterId}` : '',
        CreateTime: Date.now(),
        UpdateTime: 0,
        IsSystem: false,
        ActualInterface: 'SAW',
        CommentMedia: 'UI',
        CommentFrom: 'Agent',
        FunctionalPurpose: purposeCode || 'StatusUpdate',
        PrivacyType: commentTo === 'User' ? 'PUBLIC' : 'INTERNAL',
        CommentTo: commentTo || 'Agent',
        CommentBody: bodyHtml,
        DeltaCreateTime: 1,
        AttachmentIds: ''
      };
      return {
        entities: [{
          entity_type: 'Request',
          properties: { Id: String(ticketId), Comments: JSON.stringify({ Comment: [comment] }) }
        }],
        operation: 'UPDATE'
      };
    };

    const post = (args) => ApiClient.request('ems/bulk', {
      method: 'POST',
      body: buildPayload(args),
      useXsrf: true
    });

    const labelFor = (list, key) => (list.find(([k]) => k === key) || [])[1] || key;

    return { TO_OPTIONS, PURPOSE_OPTIONS, buildPayload, post, labelFor };
  })();

  /* =========================================================
   * ThemeManager
   * =======================================================*/
  const ThemeManager = (() => {
    const MODES = ['dark', 'gray', 'light'];
    const ICONS = { dark: '☀️', gray: '🌓', light: '🌙' };
    const TITLES = { dark: 'Mudar para modo cinza', gray: 'Mudar para modo claro', light: 'Mudar para modo escuro' };

    // Aplica somente aos elementos deste script — nunca ao <html>/<body>, que sao
    // territorio compartilhado com os outros userscripts SMAX.
    const apply = (mode) => {
      const m = MODES.includes(mode) ? mode : 'dark';
      prefs.themeMode = m;
      Store.save();
      document.querySelectorAll('.smax-gl-root').forEach(el => { el.dataset.theme = m; });
      document.querySelectorAll('.smax-gl-theme-btn').forEach(b => {
        b.textContent = ICONS[m];
        b.title = TITLES[m];
      });
    };
    const toggle = () => apply(MODES[(MODES.indexOf(prefs.themeMode) + 1) % MODES.length]);
    const current = () => (MODES.includes(prefs.themeMode) ? prefs.themeMode : 'dark');
    return { apply, toggle, current };
  })();

  /* =========================================================
   * Styles
   * =======================================================*/
  // Os tokens ficam escopados em .smax-gl-root (e nao em :root / <html>) porque o
  // SMAX Respostas e o SMAX Triagem rodam nas mesmas paginas e usam os mesmos nomes
  // --sp-* e o mesmo atributo data-smax-theme. Escopar evita que os scripts briguem.
  GM_addStyle(`
.smax-gl-root {
  --sp-bg:#dde8f4; --sp-surface:#eef4fb; --sp-surface-2:#e3edf7; --sp-elevated:#ffffff;
  --sp-text:#14273c; --sp-text-muted:#4d6075; --sp-text-dim:#73889c;
  --sp-border:#c2d2e2; --sp-border-strong:#a6bcd2;
  --sp-accent:#0a5cc0; --sp-accent-hover:#084a9e;
  --sp-primary:#0a5cc0; --sp-primary-bg:rgba(10,92,192,.08); --sp-primary-hover:rgba(10,92,192,.14);
  --sp-input-bg:#ffffff; --sp-input-border:#c2d2e2; --sp-input-text:#14273c;
  --sp-shadow:0 10px 34px rgba(20,40,70,.16), 0 0 0 1px rgba(20,40,70,.05) inset;
  --sp-card-bg:#ffffff;
  --sp-danger:#c0392b; --sp-danger-bg:#fdecec; --sp-danger-text:#b23427; --sp-danger-border:#e8b4ae;
  --sp-success:#15803d; --sp-success-bg:rgba(21,128,61,.10); --sp-success-text:#15803d;
  --sp-header-bg:#0a5cc0; --sp-header-fg:#ffffff; --sp-header-sub:rgba(255,255,255,.78);
  --sp-header-btn:rgba(255,255,255,.16); --sp-header-btn-hover:rgba(255,255,255,.30);
  --sp-send:#15803d; --sp-send-hover:#126a33;
  --sp-ring:rgba(10,92,192,.30);
  --sp-pending:#b45309; --sp-pending-bg:rgba(180,83,9,.12);
  --sp-on-accent:#ffffff;
  --sp-r-lg:12px; --sp-r-md:8px; --sp-r-sm:6px;
}
.smax-gl-root[data-theme="dark"] {
  --sp-bg:#0f1623; --sp-surface:#161f2e; --sp-surface-2:#1d2839; --sp-elevated:#1a2536;
  --sp-text:#e4ecf6; --sp-text-muted:#9aa7b8; --sp-text-dim:#647285;
  --sp-border:#2b3850; --sp-border-strong:#3a4a66;
  --sp-accent:#5aa6e6; --sp-accent-hover:#7cbcf0;
  --sp-primary:#5aa6e6; --sp-primary-bg:rgba(90,166,230,.12); --sp-primary-hover:rgba(90,166,230,.20);
  --sp-input-bg:#131c2b; --sp-input-border:#2b3850; --sp-input-text:#e4ecf6;
  --sp-shadow:0 16px 44px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.05) inset;
  --sp-card-bg:#161f2e;
  --sp-danger:#f06b6b; --sp-danger-bg:#2a1616; --sp-danger-text:#f49a9a; --sp-danger-border:#6e2424;
  --sp-success:#46c96e; --sp-success-bg:rgba(70,201,110,.12); --sp-success-text:#74e09a;
  --sp-header-bg:#16243d; --sp-header-fg:#e9f1fb; --sp-header-sub:rgba(233,241,251,.62);
  --sp-header-btn:rgba(255,255,255,.10); --sp-header-btn-hover:rgba(255,255,255,.20);
  --sp-send:#1f9d57; --sp-send-hover:#25b364;
  --sp-ring:rgba(90,166,230,.35);
  --sp-pending:#e0a83c; --sp-pending-bg:rgba(224,168,60,.14);
  --sp-on-accent:#ffffff;
}
.smax-gl-root[data-theme="gray"] {
  --sp-bg:#232323; --sp-surface:#2d2d2d; --sp-surface-2:#353535; --sp-elevated:#292929;
  --sp-text:#e9e7e4; --sp-text-muted:#9a9692; --sp-text-dim:#6f6b67;
  --sp-border:#434343; --sp-border-strong:#555555;
  --sp-accent:#d4a96a; --sp-accent-hover:#e2bc84;
  --sp-primary:#d4a96a; --sp-primary-bg:rgba(212,169,106,.12); --sp-primary-hover:rgba(212,169,106,.20);
  --sp-input-bg:#262626; --sp-input-border:#444444; --sp-input-text:#e9e7e4;
  --sp-shadow:0 16px 44px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.05) inset;
  --sp-card-bg:#2d2d2d;
  --sp-danger:#f06b6b; --sp-danger-bg:#2a1818; --sp-danger-text:#f49a9a; --sp-danger-border:#6b1e1e;
  --sp-success:#5bbf7e; --sp-success-bg:rgba(91,191,126,.12); --sp-success-text:#84d6a0;
  --sp-header-bg:#211f1c; --sp-header-fg:#ede6da; --sp-header-sub:rgba(237,230,218,.6);
  --sp-header-btn:rgba(255,255,255,.08); --sp-header-btn-hover:rgba(255,255,255,.16);
  --sp-send:#4f9e6b; --sp-send-hover:#5bb079;
  --sp-ring:rgba(212,169,106,.35);
  --sp-pending:#d6a44e; --sp-pending-bg:rgba(214,164,78,.14);
  --sp-on-accent:#1c1a16;
}

#smax-global-btn {
  position:fixed; right:12px; bottom:60px; z-index:999999;
  width:40px; height:40px; border:none; border-radius:50%;
  background:var(--sp-header-bg); color:var(--sp-header-fg);
  font-size:18px; cursor:pointer; box-shadow:var(--sp-shadow);
  display:flex; align-items:center; justify-content:center; transition:transform .12s;
}
#smax-global-btn:hover { transform:scale(1.08); }
#smax-global-btn[data-armed="true"] {
  background:var(--sp-pending); animation:smax-gl-pulse 1.6s ease-in-out infinite;
}
@keyframes smax-gl-pulse { 0%,100% { box-shadow:0 0 0 0 var(--sp-ring); } 50% { box-shadow:0 0 0 10px transparent; } }

.smax-gl-overlay {
  position:fixed; inset:0; z-index:999998; background:rgba(4,10,20,.55);
  display:flex; align-items:center; justify-content:center; padding:24px;
}
.smax-gl-modal { z-index:1000000; }
.smax-gl-panel {
  width:min(860px, 96vw); max-height:92vh; display:flex; flex-direction:column;
  background:var(--sp-bg); color:var(--sp-text);
  border:1px solid var(--sp-border); border-radius:var(--sp-r-lg);
  box-shadow:var(--sp-shadow); overflow:hidden;
  font-family:'Segoe UI', Roboto, system-ui, sans-serif;
}
.smax-gl-header {
  background:var(--sp-header-bg); color:var(--sp-header-fg);
  padding:12px 16px; display:flex; align-items:center; gap:12px; flex:0 0 auto;
}
.smax-gl-header h2 { margin:0; font-size:15px; font-weight:600; letter-spacing:.2px; }
.smax-gl-header .smax-gl-sub { font-size:11px; color:var(--sp-header-sub); }
.smax-gl-header-actions { margin-left:auto; display:flex; gap:6px; }
.smax-gl-header-actions button {
  border:none; border-radius:var(--sp-r-sm); background:var(--sp-header-btn);
  color:var(--sp-header-fg); width:28px; height:28px; cursor:pointer; font-size:13px;
}
.smax-gl-header-actions button:hover { background:var(--sp-header-btn-hover); }

.smax-gl-tabs { display:flex; gap:2px; padding:0 12px; background:var(--sp-surface-2); border-bottom:1px solid var(--sp-border); flex:0 0 auto; }
.smax-gl-tab {
  border:none; background:transparent; color:var(--sp-text-muted);
  padding:9px 14px; font-size:12px; cursor:pointer; border-bottom:2px solid transparent;
}
.smax-gl-tab[data-active="true"] { color:var(--sp-accent); border-bottom-color:var(--sp-accent); font-weight:600; }

.smax-gl-body { padding:16px; overflow-y:auto; flex:1 1 auto; }
.smax-gl-field { margin-bottom:14px; }
.smax-gl-label { display:block; font-size:11px; font-weight:600; color:var(--sp-text-muted); margin-bottom:5px; text-transform:uppercase; letter-spacing:.4px; }
.smax-gl-input, .smax-gl-editor, .smax-gl-select {
  width:100%; box-sizing:border-box; background:var(--sp-input-bg);
  border:1px solid var(--sp-input-border); color:var(--sp-input-text);
  border-radius:var(--sp-r-md); padding:8px 10px; font-size:13px;
  font-family:inherit; outline:none; transition:border-color .15s, box-shadow .15s;
}
.smax-gl-input:focus, .smax-gl-editor:focus, .smax-gl-select:focus { border-color:var(--sp-accent); box-shadow:0 0 0 3px var(--sp-ring); }
.smax-gl-editor { min-height:190px; max-height:340px; overflow-y:auto; line-height:1.5; text-align:left; }
.smax-gl-editor-sm { min-height:90px; max-height:200px; }
.smax-gl-row { display:flex; gap:8px; align-items:flex-end; margin-top:8px; }
.smax-gl-row > div { flex:1 1 0; min-width:0; }
.smax-gl-editor:empty:before { content:attr(data-placeholder); color:var(--sp-text-dim); }

.smax-gl-toolbar { display:flex; flex-wrap:wrap; gap:3px; padding:5px; background:var(--sp-surface-2); border:1px solid var(--sp-input-border); border-bottom:none; border-radius:var(--sp-r-md) var(--sp-r-md) 0 0; }
.smax-gl-toolbar + .smax-gl-editor { border-radius:0 0 var(--sp-r-md) var(--sp-r-md); }
.smax-gl-tool {
  border:1px solid transparent; background:transparent; color:var(--sp-text-muted);
  min-width:26px; height:26px; border-radius:var(--sp-r-sm); cursor:pointer; font-size:12px; padding:0 6px;
}
.smax-gl-tool:hover { background:var(--sp-primary-hover); color:var(--sp-accent); border-color:var(--sp-border); }
.smax-gl-tool-sep { width:1px; background:var(--sp-border); margin:3px 4px; }

.smax-gl-chips { display:flex; gap:6px; flex-wrap:wrap; }
.smax-gl-chip {
  border:1px solid var(--sp-border); background:var(--sp-surface); color:var(--sp-text-muted);
  border-radius:20px; padding:6px 14px; font-size:12px; cursor:pointer; transition:all .12s;
}
.smax-gl-chip:hover { border-color:var(--sp-accent); color:var(--sp-accent); }
.smax-gl-chip[data-active="true"] { background:var(--sp-primary-bg); border-color:var(--sp-accent); color:var(--sp-accent); font-weight:600; }

.smax-gl-footer {
  padding:12px 16px; border-top:1px solid var(--sp-border); background:var(--sp-surface);
  display:flex; align-items:center; gap:10px; flex:0 0 auto;
}
.smax-gl-status { font-size:11.5px; color:var(--sp-text-muted); flex:1 1 auto; }
.smax-gl-btn {
  border:1px solid var(--sp-border); background:var(--sp-surface-2); color:var(--sp-text);
  border-radius:var(--sp-r-md); padding:8px 16px; font-size:12.5px; cursor:pointer; font-weight:500;
}
.smax-gl-btn:hover { border-color:var(--sp-accent); color:var(--sp-accent); }
.smax-gl-btn[disabled] { opacity:.45; cursor:not-allowed; }
.smax-gl-btn-primary { background:var(--sp-send); border-color:var(--sp-send); color:#fff; }
.smax-gl-btn-primary:hover:not([disabled]) { background:var(--sp-send-hover); border-color:var(--sp-send-hover); color:#fff; }
.smax-gl-btn-danger { color:var(--sp-danger-text); border-color:var(--sp-danger-border); }

.smax-gl-note {
  border-radius:var(--sp-r-md); padding:10px 12px; font-size:12px; line-height:1.55;
  border:1px solid var(--sp-border); background:var(--sp-surface); color:var(--sp-text-muted); margin-bottom:14px;
}
.smax-gl-note strong { color:var(--sp-text); }
.smax-gl-note-warn { background:var(--sp-pending-bg); border-color:var(--sp-pending); color:var(--sp-text); }
.smax-gl-note-ok { background:var(--sp-success-bg); border-color:var(--sp-success); color:var(--sp-text); }
.smax-gl-note-err { background:var(--sp-danger-bg); border-color:var(--sp-danger-border); color:var(--sp-danger-text); }

.smax-gl-kv { width:100%; border-collapse:collapse; font-size:11.5px; }
.smax-gl-kv td { padding:5px 8px; border-bottom:1px solid var(--sp-border); vertical-align:top; }
.smax-gl-kv td:first-child { color:var(--sp-text-muted); width:38%; font-family:Consolas, monospace; word-break:break-all; }
.smax-gl-kv td:last-child { color:var(--sp-text); word-break:break-word; }
.smax-gl-kv tr[data-overridden="true"] td { background:var(--sp-primary-bg); }

.smax-gl-pre {
  background:var(--sp-input-bg); border:1px solid var(--sp-border); border-radius:var(--sp-r-md);
  padding:10px; font-family:Consolas, monospace; font-size:11px; line-height:1.45;
  color:var(--sp-text); max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin:0;
}
.smax-gl-cand {
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md); background:var(--sp-card-bg);
  padding:10px 12px; margin-bottom:8px; display:flex; align-items:center; gap:10px;
}
.smax-gl-cand-info { flex:1 1 auto; min-width:0; }
.smax-gl-cand-title { font-size:12.5px; font-weight:600; color:var(--sp-text); }
.smax-gl-cand-meta { font-size:11px; color:var(--sp-text-dim); font-family:Consolas, monospace; word-break:break-all; }
.smax-gl-badge { font-size:10px; padding:2px 7px; border-radius:10px; border:1px solid currentColor; white-space:nowrap; }
.smax-gl-details { border:1px solid var(--sp-border); border-radius:var(--sp-r-md); padding:10px 12px; background:var(--sp-card-bg); }
.smax-gl-details > summary { cursor:pointer; font-size:12.5px; font-weight:600; color:var(--sp-text); }
.smax-gl-badge-best { color:var(--sp-success); }

.smax-gl-person {
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md);
  background:var(--sp-card-bg); padding:10px 12px;
}
.smax-gl-person-current { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; color:var(--sp-text); }
.smax-gl-person-name { font-weight:600; flex:1 1 auto; min-width:0; word-break:break-word; }
.smax-gl-person-search { margin-top:10px; border-top:1px solid var(--sp-border); padding-top:10px; }
.smax-gl-person-hits { margin-top:8px; max-height:190px; overflow-y:auto; overflow-x:hidden; }
.smax-gl-person-hit {
  display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box; text-align:left;
  border:1px solid transparent; background:transparent; color:var(--sp-text);
  border-radius:var(--sp-r-sm); padding:6px 8px; font-size:12.5px; cursor:pointer; font-family:inherit;
}
.smax-gl-person-hit:hover { background:var(--sp-primary-bg); border-color:var(--sp-accent); }
.smax-gl-person-hit[data-current="true"] { background:var(--sp-primary-bg); }
/* Nome e login competem pela mesma linha; sem truncar, os dois juntos estouram
   a largura e a lista ganha barra horizontal. */
.smax-gl-person-hit > span, .smax-gl-person-hit small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.smax-gl-person-hit small { flex:0 1 auto; max-width:45%; color:var(--sp-text-dim); font-family:Consolas, monospace; font-size:10.5px; }
.smax-gl-person-msg { font-size:11.5px; color:var(--sp-text-muted); margin-top:8px; }
`);

  /* =========================================================
   * HUD
   * =======================================================*/
  const GlobalHUD = (() => {
    let overlay = null;
    let launcher = null;
    let activeTab = 'abrir';
    let unsubscribe = null;
    let busy = false;

    const form = {
      title: prefs.lastTitle || '',
      urgency: prefs.lastUrgency || 'med',
      descriptionHtml: '',
      // null = usa o solicitante congelado no molde. Trocar e excecao, entao nao
      // persiste entre aberturas do painel — senao uma troca pontual viraria padrao.
      requester: null,
      // Contorno comeca no padrao da equipe e e editavel; editar nao muda o padrao.
      contornoHtml: prefs.contornoPadrao || '',
      contornoTo: prefs.contornoTo || 'Agent',
      contornoPurpose: prefs.contornoPurpose || 'SolucaoContorno_c'
    };

    const personUI = { open: false, term: '', loading: false, error: '', results: [], searchSeq: 0 };
    let personDebounce = null;

    const setStatus = (msg, kind = '') => {
      const el = overlay && overlay.querySelector('.smax-gl-status');
      if (!el) return;
      el.textContent = msg || '';
      el.style.color = kind === 'err' ? 'var(--sp-danger-text)'
        : kind === 'ok' ? 'var(--sp-success-text)'
        : 'var(--sp-text-muted)';
    };

    const syncLauncher = () => {
      if (!launcher) return;
      launcher.dataset.armed = Capture.isArmed() ? 'true' : 'false';
      launcher.title = Capture.isArmed()
        ? `SMAX Global — MODO APRENDER ativo${Capture.isDryRun() ? ' (seco: o SMAX vai acusar erro ao salvar, e nada é criado)' : ' (SEM modo seco: o chamado será criado de verdade)'}`
        : 'SMAX Global — abrir chamado global';
    };

    /* ---------- Campo: solicitado para ---------- */
    const defaultRequesterId = () => Molde.getRequesterId(prefs.molde);

    const currentRequester = () => {
      if (form.requester) return form.requester;
      const id = defaultRequesterId();
      return id ? { id, name: People.nameFor(id) } : null;
    };

    const renderPersonBox = () => {
      const cur = currentRequester();
      const changed = !!form.requester && form.requester.id !== defaultRequesterId();

      const label = !cur
        ? '<span class="smax-gl-person-name" style="color:var(--sp-text-dim);">O molde não trouxe solicitante</span>'
        : `<span class="smax-gl-person-name">${Utils.escapeHtml(cur.name || `#${cur.id}`)}</span>
           <span class="smax-gl-badge ${changed ? 'smax-gl-badge-best' : ''}">${changed ? 'alterado' : 'padrão do molde'}</span>`;

      const hits = personUI.loading
        ? '<div class="smax-gl-person-msg">Buscando…</div>'
        : personUI.error
          ? `<div class="smax-gl-person-msg" style="color:var(--sp-danger-text);">${Utils.escapeHtml(personUI.error)}</div>`
          : personUI.results.length
            ? `<div class="smax-gl-person-hits">${personUI.results.map(p => `
                <button class="smax-gl-person-hit" data-act="escolher-pessoa"
                        data-id="${Utils.escapeHtml(p.id)}" data-name="${Utils.escapeHtml(p.name)}"
                        data-current="${cur && cur.id === p.id}">
                  <span style="flex:1 1 auto;min-width:0;">${Utils.escapeHtml(p.name)}</span>
                  <small>${Utils.escapeHtml(p.upn || p.id)}</small>
                </button>`).join('')}</div>`
            : `<div class="smax-gl-person-msg">${
                personUI.term.trim().length < 3
                  ? 'Digite ao menos 3 letras.'
                  : 'Nenhuma pessoa encontrada com esse início de nome.'
              }</div>`;

      return `
        <div class="smax-gl-person">
          <div class="smax-gl-person-current">
            ${label}
            ${changed ? '<button class="smax-gl-btn" data-act="resetar-solicitante">Voltar ao padrão</button>' : ''}
            <button class="smax-gl-btn" data-act="trocar-solicitante">${personUI.open ? 'Fechar busca' : 'Alterar'}</button>
          </div>
          ${personUI.open ? `
            <div class="smax-gl-person-search">
              <input id="smax-gl-person-q" class="smax-gl-input" type="text"
                     placeholder="Nome (início) — ex.: ${Utils.escapeHtml(People.SEED_TERM)}"
                     value="${Utils.escapeHtml(personUI.term)}">
              ${hits}
            </div>` : ''}
        </div>`;
    };

    // Atualiza so a caixa do solicitante: um render() inteiro destruiria o foco
    // e o caret do campo de busca a cada tecla.
    const refreshPersonBox = () => {
      const box = overlay && overlay.querySelector('#smax-gl-person-box');
      if (!box) return;
      const input = box.querySelector('#smax-gl-person-q');
      const hadFocus = input && document.activeElement === input;
      const caret = input ? input.selectionStart : null;
      box.innerHTML = renderPersonBox();
      const next = box.querySelector('#smax-gl-person-q');
      if (next && hadFocus) {
        next.focus();
        if (caret != null) next.setSelectionRange(caret, caret);
      }
    };

    const runPersonSearch = (term) => {
      personUI.term = term;
      const seq = ++personUI.searchSeq;
      if (term.trim().length < 3) {
        personUI.loading = false;
        personUI.error = '';
        personUI.results = [];
        refreshPersonBox();
        return;
      }
      personUI.loading = true;
      personUI.error = '';
      refreshPersonBox();
      People.search(term)
        .then((people) => {
          if (seq !== personUI.searchSeq) return;   // resposta de uma busca ja superada
          personUI.loading = false;
          personUI.results = people;
          refreshPersonBox();
        })
        .catch((err) => {
          if (seq !== personUI.searchSeq) return;
          personUI.loading = false;
          personUI.results = [];
          personUI.error = `Falha na busca: ${err.message || err}`;
          refreshPersonBox();
        });
    };

    // O molde guarda so o Id; busca o nome uma vez e atualiza a caixa quando chegar.
    const ensureRequesterName = () => {
      const id = defaultRequesterId();
      if (!id || People.nameFor(id)) return;
      People.resolveName(id)
        .then((name) => { if (name) refreshPersonBox(); })
        .catch(() => { /* fica mostrando #id — nao vale travar o painel por isso */ });
    };

    /* ---------- Aba: Abrir ---------- */
    const renderAbrir = () => {
      const molde = prefs.molde;
      if (!molde) {
        return `
          <div class="smax-gl-note smax-gl-note-warn">
            <strong>Nenhum molde aprendido ainda.</strong><br>
            O script precisa ver você abrir <em>um</em> chamado global pela tela nativa do SMAX
            para aprender quais campos esse tipo de chamado exige. Vá para a aba
            <strong>Aprender molde</strong> e siga os passos.
          </div>`;
      }

      const urgencyChips = Object.entries(Molde.URGENCY_PRESETS).map(([key, cfg]) => `
        <button class="smax-gl-chip" data-urgency="${key}" data-active="${form.urgency === key}">
          ${Utils.escapeHtml(cfg.label)}
        </button>`).join('');

      return `
        <div class="smax-gl-note smax-gl-note-ok">
          Molde aprendido em <strong>${Utils.formatBrDateTime(molde.capturedAt)}</strong> —
          ${Object.keys(Molde.getProperties(molde)).length} campos.
          Título, descrição, urgência e solicitante abaixo sobrescrevem o molde; todo o resto é replicado.
        </div>

        <div class="smax-gl-field">
          <label class="smax-gl-label" for="smax-gl-title">Título do chamado</label>
          <input id="smax-gl-title" class="smax-gl-input" type="text"
                 placeholder="Ex.: Indisponibilidade do SAJ — Comarca de..."
                 value="${Utils.escapeHtml(form.title)}">
        </div>

        <div class="smax-gl-field">
          <label class="smax-gl-label">Solicitado para</label>
          <div id="smax-gl-person-box">${renderPersonBox()}</div>
        </div>

        <div class="smax-gl-field">
          <label class="smax-gl-label">Urgência / impacto</label>
          <div class="smax-gl-chips">${urgencyChips}</div>
        </div>

        <div class="smax-gl-field">
          <label class="smax-gl-label">Descrição</label>
          <div class="smax-gl-toolbar">
            <button class="smax-gl-tool" data-cmd="bold" title="Negrito"><b>B</b></button>
            <button class="smax-gl-tool" data-cmd="italic" title="Itálico"><i>I</i></button>
            <button class="smax-gl-tool" data-cmd="underline" title="Sublinhado"><u>U</u></button>
            <div class="smax-gl-tool-sep"></div>
            <button class="smax-gl-tool" data-cmd="insertUnorderedList" title="Lista">&bull; Lista</button>
            <button class="smax-gl-tool" data-cmd="insertOrderedList" title="Lista numerada">1. Lista</button>
            <div class="smax-gl-tool-sep"></div>
            <button class="smax-gl-tool" data-cmd="createLink" title="Inserir link">🔗</button>
            <button class="smax-gl-tool" data-cmd="unlink" title="Remover link">⛓️‍💥</button>
            <div class="smax-gl-tool-sep"></div>
            <button class="smax-gl-tool" data-cmd="removeFormat" title="Limpar formatação">✖ Formato</button>
          </div>
          <div id="smax-gl-desc" class="smax-gl-editor" contenteditable="true"
               data-placeholder="Descreva a ocorrência que este chamado global vai concentrar..."></div>
        </div>

        <div class="smax-gl-field">
          <label class="smax-gl-label">Solução de contorno <span style="text-transform:none;font-weight:400;">— vai como discussão no chamado; deixe vazio para não postar</span></label>
          <div id="smax-gl-contorno" class="smax-gl-editor smax-gl-editor-sm" contenteditable="true"
               data-placeholder="Orientação de contorno para quem for atendido por este global..."></div>
          <div class="smax-gl-row">
            <div>
              <label class="smax-gl-label" for="smax-gl-disc-to">Para</label>
              <select id="smax-gl-disc-to" class="smax-gl-select">
                ${Discussion.TO_OPTIONS.map(([v, l]) => `
                  <option value="${v}" ${form.contornoTo === v ? 'selected' : ''}>${Utils.escapeHtml(l)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="smax-gl-label" for="smax-gl-disc-purpose">Objetivo</label>
              <select id="smax-gl-disc-purpose" class="smax-gl-select">
                ${Discussion.PURPOSE_OPTIONS.map(([v, l]) => `
                  <option value="${v}" ${form.contornoPurpose === v ? 'selected' : ''}>${Utils.escapeHtml(l)}</option>`).join('')}
              </select>
            </div>
            <button class="smax-gl-btn" data-act="salvar-contorno-padrao"
                    title="Guarda o texto e as opções atuais como padrão das próximas aberturas">Salvar como padrão</button>
          </div>
        </div>`;
    };

    /* ---------- Aba: Aprender ---------- */
    const renderAprender = () => {
      const armed = Capture.isArmed();
      const candidates = Capture.getCandidates();
      const molde = prefs.molde;

      const moldeBlock = molde ? `
        <div class="smax-gl-note smax-gl-note-ok">
          <strong>Molde atual</strong> — capturado em ${Utils.formatBrDateTime(molde.capturedAt)}<br>
          <span style="font-family:Consolas,monospace;font-size:11px;">${Utils.escapeHtml(molde.method)} ${Utils.escapeHtml(molde.path)}</span>
        </div>
        <table class="smax-gl-kv">
          ${Object.entries(Molde.getProperties(molde)).map(([k, v]) => {
            const overridden = ['DisplayLabel', 'Description', 'Urgency', 'ImpactScope', Molde.REQUESTER_KEY].includes(k);
            const stripped = Molde.STRIP_KEYS.includes(k);
            const raw = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
            const shown = raw.length > 220 ? raw.slice(0, 220) + '…' : raw;
            const tag = stripped ? ' <span class="smax-gl-badge">descartado</span>'
              : overridden ? ' <span class="smax-gl-badge smax-gl-badge-best">você edita</span>' : '';
            return `<tr data-overridden="${overridden}"><td>${Utils.escapeHtml(k)}${tag}</td><td>${Utils.escapeHtml(shown)}</td></tr>`;
          }).join('')}
        </table>
        <div style="margin-top:12px;">
          <button class="smax-gl-btn smax-gl-btn-danger" data-act="descartar-molde">Descartar molde</button>
        </div>
      ` : '';

      const mg = prefs.moldeGlobal;
      const moldeGlobalBlock = mg ? `
        <div class="smax-gl-note smax-gl-note-ok" style="margin-top:12px;">
          <strong>Passo 2 — “É Global”</strong> — capturado em ${Utils.formatBrDateTime(mg.capturedAt)}<br>
          <span style="font-family:Consolas,monospace;font-size:11px;">${Utils.escapeHtml(mg.method)} ${Utils.escapeHtml(mg.path)}</span>
          <div style="margin-top:8px;">
            <button class="smax-gl-btn smax-gl-btn-danger" data-act="descartar-molde-global">Descartar passo 2</button>
          </div>
        </div>` : (molde ? `
        <div class="smax-gl-note smax-gl-note-warn" style="margin-top:12px;">
          <strong>Passo 2 ainda não aprendido.</strong> “É Global” é marcado depois de salvar, na aba
          Classificação — sem capturar esse momento o script cria um chamado comum, não um global.
        </div>` : '');

      const candBlock = candidates.length ? `
        <div class="smax-gl-label" style="margin-top:18px;">Capturas desta sessão (${candidates.length})</div>
        ${candidates.map((c, i) => `
          <div class="smax-gl-cand">
            <div class="smax-gl-cand-info">
              <div class="smax-gl-cand-title">
                ${Utils.escapeHtml(String(c.body.operation || '?'))}
                ${(c.body.entities || []).map(e => Utils.escapeHtml(String(e.entity_type || '?'))).join(', ') || '—'}
                ${c.score >= 100 ? '<span class="smax-gl-badge smax-gl-badge-best">melhor candidato</span>' : ''}
                ${c.blocked ? '<span class="smax-gl-badge smax-gl-badge-best">não foi salvo</span>' : '<span class="smax-gl-badge">salvo no SMAX</span>'}
              </div>
              <div class="smax-gl-cand-meta">${Utils.formatBrDateTime(c.capturedAt)} · ${Utils.escapeHtml(c.method)} ${Utils.escapeHtml(c.url)}</div>
            </div>
            <button class="smax-gl-btn" data-act="ver-candidato" data-idx="${i}">Ver</button>
            <button class="smax-gl-btn smax-gl-btn-primary" data-act="usar-candidato" data-idx="${i}">Usar como molde</button>
            <button class="smax-gl-btn" data-act="usar-candidato-global" data-idx="${i}" title="Use na captura do momento em que você marcou &quot;É Global&quot;">Usar como passo 2 (É Global)</button>
          </div>`).join('')}
      ` : (armed ? `
        <div class="smax-gl-note">
          Aguardando… Abra agora um chamado global normalmente pela tela do SMAX.
          Assim que você salvar, a captura aparece aqui.
        </div>` : '');

      // Diagnostico: se nada virou candidato, mostra o que passou e por que foi
      // descartado. E isso que permite corrigir a heuristica sem adivinhar.
      const sniffed = Capture.getSniffer();
      const sniffBlock = sniffed.length ? `
        <details class="smax-gl-details" style="margin-top:18px;">
          <summary>Diagnóstico — ${sniffed.length} requisição(ões) vista(s) e descartada(s)</summary>
          <div class="smax-gl-note" style="margin-top:8px;">
            Se o chamado foi aberto e nada apareceu como captura, o payload do SMAX está aqui.
            Use <strong>Copiar diagnóstico</strong> e me mande.
          </div>
          ${sniffed.map(s => `
            <div class="smax-gl-cand">
              <div class="smax-gl-cand-info">
                <div class="smax-gl-cand-title">${Utils.escapeHtml(s.method)} <span class="smax-gl-badge">${Utils.escapeHtml(s.reason)}</span></div>
                <div class="smax-gl-cand-meta">${Utils.formatBrDateTime(s.t)} · ${Utils.escapeHtml(s.url)}</div>
                <div class="smax-gl-cand-meta" style="font-family:Consolas,monospace;white-space:pre-wrap;word-break:break-all;">${Utils.escapeHtml(s.preview)}</div>
              </div>
            </div>`).join('')}
          <div style="margin-top:10px;">
            <button class="smax-gl-btn" data-act="copiar-diagnostico">Copiar diagnóstico</button>
          </div>
        </details>` : '';

      const dry = Capture.isDryRun();

      return `
        <div class="smax-gl-note ${armed ? 'smax-gl-note-warn' : ''}">
          <strong>Como funciona</strong><br>
          1. Clique em <strong>Ativar modo aprender</strong>.<br>
          2. Preencha <em>um</em> chamado global normalmente, pela tela nativa do SMAX, e
             <strong>salve</strong>. Depois marque <strong>“É Global”</strong> em Classificação e
             salve de novo. São duas requisições: a criação e a marcação.<br>
          3. Volte aqui: use a captura <em>CREATE</em> em <strong>Usar como molde</strong> e a
             captura do <em>UPDATE</em> em <strong>Usar como passo 2</strong>.<br>
          4. A partir daí, a aba <strong>Abrir</strong> replica os dois, trocando título, descrição,
             urgência e solicitante.
        </div>

        <div class="smax-gl-note ${dry ? 'smax-gl-note-ok' : 'smax-gl-note-warn'}">
          <strong>${dry ? 'Modo seco ligado — nada é salvo.' : 'Modo seco desligado — o chamado é criado de verdade.'}</strong><br>
          ${dry
            ? `Ao salvar, o script <strong>intercepta e cancela</strong> a requisição: ela não sai do
               navegador. O SMAX vai <strong>acusar erro ao salvar</strong> — esse erro é justamente a
               prova de que nada foi criado. O payload já terá sido capturado.<br>
               Para o passo 2, marque “É Global” em um chamado comum qualquer e salve: o chamado
               também não é alterado.<br>
               <em>Se a tela travar em vez de acusar erro, recarregue — a captura fica guardada.</em>`
            : `Ao salvar, a requisição vai ao SMAX normalmente e o chamado <strong>é aberto em
               produção</strong>. Use isso só se o modo seco não funcionar nesta tela.`}
          <div style="margin-top:8px;">
            <button class="smax-gl-btn" data-act="toggle-seco">
              ${dry ? 'Desligar modo seco (vai salvar de verdade)' : 'Ligar modo seco (não salva)'}
            </button>
          </div>
        </div>

        <div style="display:flex; gap:8px; margin-bottom:14px;">
          <button class="smax-gl-btn ${armed ? 'smax-gl-btn-danger' : 'smax-gl-btn-primary'}" data-act="toggle-aprender">
            ${armed ? '⏹ Parar modo aprender' : '⏺ Ativar modo aprender'}
          </button>
          ${candidates.length || sniffed.length ? '<button class="smax-gl-btn" data-act="limpar-capturas">Limpar capturas</button>' : ''}
        </div>

        ${moldeBlock}
        ${moldeGlobalBlock}
        ${candBlock}
        ${sniffBlock}`;
    };

    /* ---------- Render ---------- */
    const render = () => {
      if (!overlay) return;
      const body = overlay.querySelector('.smax-gl-body');
      const footer = overlay.querySelector('.smax-gl-footer-actions');

      overlay.querySelectorAll('.smax-gl-tab').forEach(t => {
        t.dataset.active = String(t.dataset.tab === activeTab);
      });

      body.innerHTML = activeTab === 'abrir' ? renderAbrir() : renderAprender();

      // Restaura o conteudo dos editores (innerHTML nao sobrevive ao re-render)
      const desc = body.querySelector('#smax-gl-desc');
      if (desc) desc.innerHTML = form.descriptionHtml;
      const contorno = body.querySelector('#smax-gl-contorno');
      if (contorno) contorno.innerHTML = form.contornoHtml;

      footer.innerHTML = activeTab === 'abrir' && prefs.molde
        ? `<button class="smax-gl-btn" data-act="preview">Ver payload</button>
           <button class="smax-gl-btn smax-gl-btn-primary" data-act="criar" ${busy ? 'disabled' : ''}>
             ${busy ? 'Criando…' : '🌐 Abrir chamado global'}
           </button>`
        : '';

      if (activeTab === 'abrir' && prefs.molde) ensureRequesterName();
      syncLauncher();
    };

    /* ---------- Leitura do formulario ---------- */
    const readForm = () => {
      const titleEl = overlay.querySelector('#smax-gl-title');
      const descEl = overlay.querySelector('#smax-gl-desc');
      const contornoEl = overlay.querySelector('#smax-gl-contorno');
      const toEl = overlay.querySelector('#smax-gl-disc-to');
      const purposeEl = overlay.querySelector('#smax-gl-disc-purpose');
      if (titleEl) form.title = titleEl.value.trim();
      if (descEl) form.descriptionHtml = descEl.innerHTML;
      if (contornoEl) form.contornoHtml = contornoEl.innerHTML;
      if (toEl) form.contornoTo = toEl.value;
      if (purposeEl) form.contornoPurpose = purposeEl.value;
      const contornoHtml = Utils.normalizeContentEditableHtml(form.contornoHtml);
      return {
        title: form.title,
        urgency: form.urgency,
        descriptionHtml: Utils.normalizeContentEditableHtml(form.descriptionHtml),
        requesterId: form.requester ? form.requester.id : '',
        // Vazio = nao posta discussao nenhuma.
        contornoHtml: Utils.htmlToText(contornoHtml) ? contornoHtml : '',
        contornoTo: form.contornoTo,
        contornoPurpose: form.contornoPurpose
      };
    };

    const validate = (data) => {
      if (!prefs.molde) return 'Nenhum molde aprendido.';
      // Com o modo aprender ligado o script cancelaria a propria criacao (seco)
      // ou capturaria a si mesmo como candidato. Nos dois casos, so confunde.
      if (Capture.isArmed()) return 'Desligue o modo aprender antes de abrir um chamado.';
      if (!data.title) return 'Informe o título do chamado.';
      if (!Utils.htmlToText(data.descriptionHtml)) return 'Informe a descrição do chamado.';
      if (!data.requesterId && !defaultRequesterId()) return 'Escolha para quem o chamado será aberto.';
      return '';
    };

    /* ---------- Modal de confirmacao ---------- */
    const confirmModal = (payload, contornoPayload = null) => new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'smax-gl-overlay smax-gl-modal smax-gl-root';
      wrap.dataset.theme = ThemeManager.current();
      wrap.innerHTML = `
        <div class="smax-gl-panel" style="width:min(720px,94vw);">
          <div class="smax-gl-header">
            <div>
              <h2>Confirmar abertura</h2>
              <div class="smax-gl-sub">Este é o payload exato que será enviado ao SMAX</div>
            </div>
          </div>
          <div class="smax-gl-body">
            <div class="smax-gl-note smax-gl-note-warn">
              Isso cria um chamado <strong>real</strong> no SMAX de produção. Revise antes de confirmar.
            </div>
            <div class="smax-gl-label">1. Criar o chamado</div>
            <pre class="smax-gl-pre">${Utils.escapeHtml(JSON.stringify(payload, null, 2))}</pre>
            ${prefs.moldeGlobal
              ? '<div class="smax-gl-note smax-gl-note-ok">2. Marcar <strong>“É Global”</strong> — replay do passo 2 aprendido, com o Id do chamado novo.</div>'
              : '<div class="smax-gl-note smax-gl-note-warn">2. <strong>“É Global” não será marcado</strong> — o passo 2 não foi aprendido. O chamado nascerá comum.</div>'}
            ${contornoPayload ? `
              <div class="smax-gl-label" style="margin-top:12px;">3. Postar a solução de contorno</div>
              <pre class="smax-gl-pre">${Utils.escapeHtml(JSON.stringify(contornoPayload, null, 2))}</pre>`
              : '<div class="smax-gl-note">3. Nenhuma solução de contorno será postada (campo vazio).</div>'}
          </div>
          <div class="smax-gl-footer">
            <div class="smax-gl-status"></div>
            <button class="smax-gl-btn" data-act="copiar">Copiar payload</button>
            <button class="smax-gl-btn" data-act="cancelar">Cancelar</button>
            <button class="smax-gl-btn smax-gl-btn-primary" data-act="ok">Confirmar e criar</button>
          </div>
        </div>`;

      const close = (result) => { wrap.remove(); resolve(result); };

      wrap.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (!act) { if (ev.target === wrap) close(false); return; }
        if (act === 'ok') close(true);
        else if (act === 'cancelar') close(false);
        else if (act === 'copiar') {
          navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
            .then(() => { wrap.querySelector('.smax-gl-status').textContent = 'Payload copiado.'; })
            .catch(() => { wrap.querySelector('.smax-gl-status').textContent = 'Falha ao copiar.'; });
        }
      });

      document.body.appendChild(wrap);
    });

    const infoModal = (title, contentHtml) => {
      const wrap = document.createElement('div');
      wrap.className = 'smax-gl-overlay smax-gl-modal smax-gl-root';
      wrap.dataset.theme = ThemeManager.current();
      wrap.innerHTML = `
        <div class="smax-gl-panel" style="width:min(720px,94vw);">
          <div class="smax-gl-header">
            <h2>${Utils.escapeHtml(title)}</h2>
            <div class="smax-gl-header-actions"><button data-act="fechar">✕</button></div>
          </div>
          <div class="smax-gl-body">${contentHtml}</div>
        </div>`;
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-act="fechar"]')) wrap.remove();
      });
      document.body.appendChild(wrap);
    };

    /* ---------- Criacao ---------- */
    const criar = async () => {
      const data = readForm();
      const problem = validate(data);
      if (problem) { setStatus(problem, 'err'); return; }

      const payload = Molde.buildPayload(prefs.molde, data);

      // O Id real so existe depois do CREATE; no preview fica um marcador.
      const contornoPreview = data.contornoHtml
        ? Discussion.buildPayload({
            ticketId: '<id do chamado que será criado>',
            bodyHtml: data.contornoHtml,
            commentTo: data.contornoTo,
            purposeCode: data.contornoPurpose
          })
        : null;

      if (!(await confirmModal(payload, contornoPreview))) { setStatus('Cancelado.'); return; }

      if (!prefs.enableRealWrites) {
        setStatus('Escritas reais desabilitadas — nada foi enviado.', 'err');
        console.warn('[SMAX Global] enableRealWrites=false; payload:', payload);
        return;
      }

      busy = true;
      render();
      setStatus('Enviando…');

      try {
        // Replay no mesmo endpoint/metodo que a UI nativa usou.
        const res = await ApiClient.request(prefs.molde.path, {
          method: prefs.molde.method || 'POST',
          body: payload,
          useXsrf: true
        });
        const status = Molde.completionStatus(res);
        const newId = Molde.extractCreatedId(res);

        if (newId) {
          prefs.lastTitle = data.title;
          prefs.lastUrgency = data.urgency;
          Store.save();

          // Passo 2 — sem isso o chamado nasce comum, nao global.
          let flagNote = `
            <div class="smax-gl-note smax-gl-note-warn">
              <strong>Falta marcar “É Global”.</strong> Nenhum molde do passo 2 foi aprendido,
              então abra o chamado e marque manualmente em Classificação → É Global.
            </div>`;
          if (prefs.moldeGlobal) {
            setStatus(`#${newId} criado — marcando como global…`);
            try {
              const resFlag = await ApiClient.request(prefs.moldeGlobal.path, {
                method: prefs.moldeGlobal.method || 'POST',
                body: Molde.buildGlobalFlagPayload(prefs.moldeGlobal, newId),
                useXsrf: true
              });
              const okFlag = Molde.completionStatus(resFlag) === 'OK';
              flagNote = okFlag
                ? `<div class="smax-gl-note smax-gl-note-ok">Marcado como <strong>É Global</strong>.</div>`
                : `<div class="smax-gl-note smax-gl-note-err">
                     O chamado foi criado, mas a marcação <strong>É Global</strong> não foi confirmada
                     (${Utils.escapeHtml(Molde.completionStatus(resFlag) || 'sem status')}).
                     Marque manualmente em Classificação → É Global.
                   </div>`;
            } catch (errFlag) {
              flagNote = `<div class="smax-gl-note smax-gl-note-err">
                  O chamado foi criado, mas falhou ao marcar <strong>É Global</strong>:
                  ${Utils.escapeHtml(errFlag.message || String(errFlag))}.
                  Marque manualmente em Classificação → É Global.
                </div>`;
            }
          }

          // Passo 3 — solucao de contorno como discussao. Falhar aqui nao invalida
          // o chamado: ele existe e ja esta marcado como global.
          let contornoNote = '';
          if (data.contornoHtml) {
            const rotulo = Discussion.labelFor(Discussion.PURPOSE_OPTIONS, data.contornoPurpose);
            setStatus(`#${newId} criado — postando ${rotulo}…`);
            try {
              const resDisc = await Discussion.post({
                ticketId: newId,
                bodyHtml: data.contornoHtml,
                commentTo: data.contornoTo,
                purposeCode: data.contornoPurpose
              });
              contornoNote = Molde.completionStatus(resDisc) === 'OK'
                ? `<div class="smax-gl-note smax-gl-note-ok"><strong>${Utils.escapeHtml(rotulo)}</strong> postada como discussão.</div>`
                : `<div class="smax-gl-note smax-gl-note-err">
                     A discussão <strong>${Utils.escapeHtml(rotulo)}</strong> não foi confirmada
                     (${Utils.escapeHtml(Molde.completionStatus(resDisc) || 'sem status')}). Poste manualmente.
                   </div>`;
            } catch (errDisc) {
              contornoNote = `<div class="smax-gl-note smax-gl-note-err">
                  Falhou ao postar <strong>${Utils.escapeHtml(rotulo)}</strong>:
                  ${Utils.escapeHtml(errDisc.message || String(errDisc))}. Poste manualmente.
                </div>`;
            }
          }

          form.descriptionHtml = '';
          // O contorno volta ao padrao, nao para vazio: ele e texto de equipe.
          form.contornoHtml = prefs.contornoPadrao || '';
          busy = false;
          render();
          const url = `${window.location.origin}/saw/Request/${encodeURIComponent(newId)}/general`;
          setStatus(`Chamado global #${newId} criado.`, 'ok');
          infoModal('Chamado global criado', `
            <div class="smax-gl-note smax-gl-note-ok">
              <strong>Chamado #${Utils.escapeHtml(newId)}</strong> criado com sucesso.
            </div>
            ${flagNote}
            ${contornoNote}
            <p style="font-size:12.5px;">
              <a href="${Utils.escapeHtml(url)}" target="_blank" rel="noopener"
                 style="color:var(--sp-accent);">Abrir #${Utils.escapeHtml(newId)} no SMAX ↗</a>
            </p>
            <details><summary style="cursor:pointer;font-size:12px;color:var(--sp-text-muted);">Resposta da API</summary>
              <pre class="smax-gl-pre" style="margin-top:8px;">${Utils.escapeHtml(JSON.stringify(res, null, 2))}</pre>
            </details>`);
        } else {
          busy = false;
          render();
          setStatus(`SMAX respondeu ${status || 'sem ID'} — verifique o retorno.`, 'err');
          infoModal('Resposta inesperada', `
            <div class="smax-gl-note smax-gl-note-err">
              O SMAX aceitou a requisição mas não foi possível extrair o ID do chamado criado.
              Verifique no SMAX se o chamado foi ou não aberto antes de tentar de novo.
            </div>
            <pre class="smax-gl-pre">${Utils.escapeHtml(JSON.stringify(res, null, 2))}</pre>`);
        }
      } catch (err) {
        busy = false;
        render();
        setStatus(`Falha: ${err.message}`, 'err');
        infoModal('Falha ao criar chamado', `
          <div class="smax-gl-note smax-gl-note-err">${Utils.escapeHtml(err.message)}</div>
          ${err.body ? `<pre class="smax-gl-pre">${Utils.escapeHtml(String(err.body).slice(0, 4000))}</pre>` : ''}
          <p style="font-size:12px;color:var(--sp-text-muted);">
            Se o erro citar um campo obrigatório ausente, o molde provavelmente está incompleto —
            recapture abrindo um global manualmente na aba <strong>Aprender molde</strong>.
          </p>`);
      }
    };

    /* ---------- Eventos ---------- */
    const wire = () => {
      overlay.addEventListener('click', (ev) => {
        const tab = ev.target.closest('.smax-gl-tab');
        if (tab) { readForm(); activeTab = tab.dataset.tab; render(); return; }

        const chip = ev.target.closest('[data-urgency]');
        if (chip) {
          form.urgency = chip.dataset.urgency;
          readForm();
          render();
          return;
        }

        const tool = ev.target.closest('.smax-gl-tool');
        if (tool) {
          ev.preventDefault();
          const cmd = tool.dataset.cmd;
          const editor = overlay.querySelector('#smax-gl-desc');
          if (!editor) return;
          editor.focus();
          if (cmd === 'createLink') {
            const url = prompt('URL do link:');
            if (url) document.execCommand('createLink', false, url);
          } else {
            document.execCommand(cmd, false, null);
          }
          form.descriptionHtml = editor.innerHTML;
          return;
        }

        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (!act) {
          if (ev.target === overlay) close();
          return;
        }

        if (act === 'fechar') { close(); }
        else if (act === 'tema') { ThemeManager.toggle(); }
        else if (act === 'trocar-solicitante') {
          personUI.open = !personUI.open;
          refreshPersonBox();
          if (personUI.open) {
            const input = overlay.querySelector('#smax-gl-person-q');
            if (input) input.focus();
            // Abre ja com os solicitantes validos de global listados.
            if (!personUI.results.length) runPersonSearch(personUI.term || People.SEED_TERM);
          }
        }
        else if (act === 'resetar-solicitante') {
          form.requester = null;
          refreshPersonBox();
          setStatus('Solicitante de volta ao padrão do molde.');
        }
        else if (act === 'escolher-pessoa') {
          const btn = ev.target.closest('[data-id]');
          form.requester = { id: btn.dataset.id, name: btn.dataset.name };
          personUI.open = false;
          refreshPersonBox();
          setStatus(`Solicitado para: ${form.requester.name}.`, 'ok');
        }
        else if (act === 'criar') { criar(); }
        else if (act === 'preview') {
          const data = readForm();
          const problem = validate(data);
          if (problem) { setStatus(problem, 'err'); return; }
          infoModal('Payload que será enviado', `
            <pre class="smax-gl-pre">${Utils.escapeHtml(JSON.stringify(Molde.buildPayload(prefs.molde, data), null, 2))}</pre>`);
        }
        else if (act === 'salvar-contorno-padrao') {
          readForm();
          prefs.contornoPadrao = Utils.normalizeContentEditableHtml(form.contornoHtml);
          prefs.contornoTo = form.contornoTo;
          prefs.contornoPurpose = form.contornoPurpose;
          Store.save();
          setStatus('Padrão da solução de contorno salvo.', 'ok');
        }
        else if (act === 'toggle-aprender') {
          Capture.isArmed() ? Capture.disarm() : Capture.arm();
          render();
        }
        else if (act === 'toggle-seco') {
          const ligando = !Capture.isDryRun();
          if (!ligando && !confirm('Desligar o modo seco faz o SMAX salvar de verdade: o chamado que você usar para aprender será aberto em produção. Continuar?')) return;
          Capture.setDryRun(ligando);
          render();
          setStatus(ligando ? 'Modo seco ligado — nada será salvo.' : 'Modo seco desligado — o chamado será aberto de verdade.', ligando ? 'ok' : 'err');
        }
        else if (act === 'limpar-capturas') { Capture.clear(); render(); }
        else if (act === 'copiar-diagnostico') {
          const dump = {
            versao: SMAX_GLOBAL_VERSION,
            armado: Capture.isArmed(),
            capturas: Capture.getCandidates().length,
            descartadas: Capture.getSniffer()
          };
          navigator.clipboard.writeText(JSON.stringify(dump, null, 2))
            .then(() => infoModal('Diagnóstico copiado', '<p>Cole na conversa para análise.</p>'))
            .catch(() => infoModal('Falha ao copiar', `<pre class="smax-gl-pre">${Utils.escapeHtml(JSON.stringify(dump, null, 2))}</pre>`));
        }
        else if (act === 'descartar-molde') {
          if (confirm('Descartar o molde aprendido? Você precisará capturar outro para abrir chamados.')) {
            prefs.molde = null;
            Store.save();
            render();
          }
        }
        else if (act === 'ver-candidato') {
          const c = Capture.getCandidates()[Number(ev.target.closest('[data-idx]').dataset.idx)];
          if (c) infoModal('Payload capturado', `
            <pre class="smax-gl-pre">${Utils.escapeHtml(JSON.stringify(c.body, null, 2))}</pre>`);
        }
        else if (act === 'usar-candidato') {
          const c = Capture.getCandidates()[Number(ev.target.closest('[data-idx]').dataset.idx)];
          const molde = c && Molde.fromCandidate(c);
          if (!molde) { setStatus('Não foi possível extrair um molde dessa captura.', 'err'); return; }
          prefs.molde = molde;
          Store.save();
          // Nao desarma: ainda falta capturar o passo 2 ("E Global").
          render();
          setStatus(prefs.moldeGlobal
            ? 'Molde salvo. Já dá para abrir chamados.'
            : 'Molde salvo. Falta o passo 2 — capture o momento em que você marca “É Global”.', 'ok');
        }
        else if (act === 'usar-candidato-global') {
          const c = Capture.getCandidates()[Number(ev.target.closest('[data-idx]').dataset.idx)];
          const molde = c && Molde.fromCandidate(c);
          if (!molde) { setStatus('Não foi possível extrair um molde dessa captura.', 'err'); return; }
          prefs.moldeGlobal = molde;
          Store.save();
          render();
          setStatus('Passo 2 salvo — o script vai marcar “É Global” após criar.', 'ok');
        }
        else if (act === 'descartar-molde-global') {
          prefs.moldeGlobal = null;
          Store.save();
          render();
        }
      });

      overlay.addEventListener('change', (ev) => {
        if (ev.target.id === 'smax-gl-disc-to') form.contornoTo = ev.target.value;
        if (ev.target.id === 'smax-gl-disc-purpose') form.contornoPurpose = ev.target.value;
      });

      overlay.addEventListener('input', (ev) => {
        if (ev.target.id === 'smax-gl-title') form.title = ev.target.value;
        if (ev.target.id === 'smax-gl-desc') form.descriptionHtml = ev.target.innerHTML;
        if (ev.target.id === 'smax-gl-contorno') form.contornoHtml = ev.target.innerHTML;
        if (ev.target.id === 'smax-gl-person-q') {
          personUI.term = ev.target.value;
          clearTimeout(personDebounce);
          const term = personUI.term;
          personDebounce = setTimeout(() => runPersonSearch(term), 300);
        }
      });

      // Cola sempre como texto limpo — evita trazer markup do Word/Outlook.
      overlay.addEventListener('paste', (ev) => {
        if (ev.target.id !== 'smax-gl-desc' && ev.target.id !== 'smax-gl-contorno') return;
        const html = ev.clipboardData.getData('text/html');
        if (!html) return;
        ev.preventDefault();
        document.execCommand('insertHTML', false, Utils.normalizeContentEditableHtml(html));
      });
    };

    const onKeydown = (ev) => {
      // Nao fecha o painel se houver um modal por cima dele.
      if (ev.key === 'Escape' && overlay && !document.querySelector('.smax-gl-modal')) close();
    };

    const close = () => {
      if (!overlay) return;
      readForm();
      overlay.remove();
      overlay = null;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      document.removeEventListener('keydown', onKeydown);
      syncLauncher();
    };

    const open = () => {
      if (overlay) { close(); return; }
      overlay = document.createElement('div');
      overlay.className = 'smax-gl-overlay smax-gl-root';
      overlay.innerHTML = `
        <div class="smax-gl-panel">
          <div class="smax-gl-header">
            <div>
              <h2>🌐 SMAX Global</h2>
              <div class="smax-gl-sub">Abertura automatizada de chamado global · v${SMAX_GLOBAL_VERSION}</div>
            </div>
            <div class="smax-gl-header-actions">
              <button class="smax-gl-theme-btn" data-act="tema">🌓</button>
              <button data-act="fechar">✕</button>
            </div>
          </div>
          <div class="smax-gl-tabs">
            <button class="smax-gl-tab" data-tab="abrir">Abrir chamado</button>
            <button class="smax-gl-tab" data-tab="aprender">Aprender molde</button>
          </div>
          <div class="smax-gl-body"></div>
          <div class="smax-gl-footer">
            <div class="smax-gl-status"></div>
            <div class="smax-gl-footer-actions" style="display:flex;gap:8px;"></div>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      wire();
      document.addEventListener('keydown', onKeydown);
      unsubscribe = Capture.onChange(() => { if (activeTab === 'aprender') render(); syncLauncher(); });

      // Solicitante e contorno voltam ao padrao a cada abertura do painel: uma
      // troca pontual nao deve virar o padrao silencioso da proxima abertura.
      form.requester = null;
      form.contornoHtml = prefs.contornoPadrao || '';
      form.contornoTo = prefs.contornoTo || 'Agent';
      form.contornoPurpose = prefs.contornoPurpose || 'SolucaoContorno_c';
      Object.assign(personUI, { open: false, term: '', loading: false, error: '', results: [] });

      activeTab = prefs.molde ? 'abrir' : 'aprender';
      ThemeManager.apply(ThemeManager.current());
      render();
    };

    const init = () => {
      if (launcher) return;
      launcher = document.createElement('button');
      launcher.id = 'smax-global-btn';
      launcher.className = 'smax-gl-root';
      launcher.textContent = '🌐';
      launcher.addEventListener('click', open);
      document.body.appendChild(launcher);
      syncLauncher();
      Capture.onChange(syncLauncher);
    };

    return { init, open };
  })();

  /* =========================================================
   * Boot
   * =======================================================*/
  Utils.onDomReady(() => {
    GlobalHUD.init();
    ThemeManager.apply(ThemeManager.current());
    console.log(`[SMAX Global] v${SMAX_GLOBAL_VERSION} carregado. Tenant: ${ApiClient.getTenantId() || 'não resolvido'}`);
  });
})();
