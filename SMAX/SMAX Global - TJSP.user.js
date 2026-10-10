// ==UserScript==
// @name         SMAX Painel de Globais - TJSP
// @namespace    https://github.com/rsalvessap/SMAX-Global
// @version      1.18
// @description  Painel de gestao de chamados globais do SMAX TJSP — lista curada, classificacao por assunto/base/competencia, sincronizacao por arquivo no GitHub e abertura automatizada de global por molde
// @author       rsalvessap
// @match        https://suporte.tjsp.jus.br/saw/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      api.github.com
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

  const SMAX_GLOBAL_VERSION = '1.18';

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
   * PgStore — armazenamento do Painel de Globais
   *
   * Duas chaves separadas DE PROPOSITO:
   *   smax_pg_dados = a lista curada de globais e as listas de valores. E isto,
   *                   e so isto, que vai para o arquivo do GitHub.
   *   smax_pg_prefs = token do GitHub, URL do arquivo. O token NUNCA entra no
   *                   arquivo publicado. Mesma separacao que o SMAX Respostas
   *                   faz entre smax_prefs e smax_personal_prefs.
   *
   * O cache do que for lido do SMAX (smax_pg_estado) entra na fase em que
   * existir leitura para guardar — e tera de ser persistido, nao de memoria: o
   * SMAX recarrega a pagina ao navegar, e foi essa a armadilha que custou a
   * v1.1 deste script.
   * =======================================================*/
  const PgStore = (() => {
    const K_DADOS = 'smax_pg_dados';
    const K_PREFS = 'smax_pg_prefs';
    const K_ESTADO = 'smax_pg_estado';
    /* Novidades achadas pelo monitor, e a agenda da proxima sondagem. Chaves
     * separadas do estado porque tem ciclo de vida proprio: o estado e cache
     * descartavel que se reescreve inteiro a cada leitura, a novidade e historico
     * que so sai quando o usuario manda, e a agenda e coordenada ENTRE ABAS. */
    const K_NOVID = 'smax_pg_novidades';
    const K_MON = 'smax_pg_monitor';
    const SCHEMA = 1;
    // Teto do historico de novidades. Um global movimentado gera varias por dia;
    // sem teto, a chave cresceria para sempre e cada gravacao ficaria mais caras.
    const MAX_NOVID = 200;

    const dadosVazio = () => ({
      _schema: SCHEMA,
      _version: 0,
      _updatedAt: '',
      eixos: { assunto: [], base: [], competencia: [] },
      globais: []
    });

    const prefsDefaults = {
      arquivoUrl: 'https://raw.githubusercontent.com/rsalvessap/SMAX-TOOLS/master/painel-globais.json',
      githubToken: '',
      // Ultimos filtros do painel. Ficam aqui, e nao em smax_pg_dados, porque sao
      // escolha desta maquina — nao entram no arquivo publicado.
      filtros: { assunto: [], base: [], competencia: [], status: '', termo: '', verArquivados: false },
      ordem: 'filhos',
      ordemAsc: false,
      // Largura em px por coluna da tabela do painel, so o que o usuario
      // arrastou — coluna ausente aqui usa o padrao definido em `COLUNAS`.
      // Guardar o ajuste e o que faz o arraste valer a pena: o painel re-renderiza
      // a cada clique (filtro, arquivar, ordenar), e largura so em memoria voltaria
      // ao padrao no primeiro clique depois do ajuste.
      larguras: {},
      /* Monitoramento (fase 6). `minutos` e o intervalo entre sondagens;
       * `notificarSO` e a notificacao do sistema operacional, que e opcional de
       * proposito — o selo no botao flutuante e o aviso na tela funcionam sempre,
       * mas a notificacao do SO pode ser engolida pelo Assistente de Foco do
       * Windows, e aviso que pode nao chegar nao serve como unico canal. */
      monitor: { ligado: true, minutos: 30, notificarSO: false },
      /* GSEs escolhidas na aba Consultar, [{id,nome}]. Persistem porque o SMAX
       * RECARREGA a pagina a cada navegacao: escolha so em memoria obrigaria a
       * redigitar as GSEs em toda consulta, que e o custo de usar a aba. Ficam
       * aqui, e nao em smax_pg_dados, pelo mesmo motivo dos filtros — e escolha
       * desta maquina e nao entra no arquivo publicado. */
      consultaGses: []
    };

    const saneaValores = (arr) => Array.isArray(arr)
      ? arr.filter(v => v && v.id && v.nome).map(v => ({ id: String(v.id), nome: String(v.nome) }))
      : [];

    const saneaMarcas = (arr) => Array.isArray(arr) ? arr.filter(Boolean).map(String) : [];

    // Normaliza o que vier de fora (storage local ou GitHub) para a forma
    // esperada. Nao inventa dado: garante que os campos existem, para o resto
    // do codigo nao ter de checar tipo a cada acesso. Preserva o _schema lido
    // como veio — quem decide o que fazer com schema desconhecido e o GitSync.
    const sanear = (raw) => {
      if (!raw || typeof raw !== 'object') return dadosVazio();
      const eixos = raw.eixos && typeof raw.eixos === 'object' ? raw.eixos : {};
      return {
        _schema: Number(raw._schema) || 1,
        _version: Number(raw._version) || 0,
        _updatedAt: typeof raw._updatedAt === 'string' ? raw._updatedAt : '',
        eixos: {
          assunto: saneaValores(eixos.assunto),
          base: saneaValores(eixos.base),
          competencia: saneaValores(eixos.competencia)
        },
        globais: (Array.isArray(raw.globais) ? raw.globais : [])
          .filter(g => g && g.id)
          .map(g => ({
            id: String(g.id),
            incluidoEm: typeof g.incluidoEm === 'string' ? g.incluidoEm : '',
            assunto: saneaMarcas(g.assunto),
            base: saneaMarcas(g.base),
            competencia: saneaMarcas(g.competencia),
            nota: typeof g.nota === 'string' ? g.nota : '',
            arquivado: g.arquivado === true
          }))
      };
    };

    let dados = dadosVazio();
    const pgPrefs = { ...prefsDefaults };

    try {
      const raw = GM_getValue(K_DADOS);
      if (raw) dados = sanear(JSON.parse(raw));
    } catch (err) {
      console.warn('[SMAX Painel] smax_pg_dados ilegivel, comecando vazio:', err);
    }

    try {
      const raw = GM_getValue(K_PREFS);
      if (raw) Object.assign(pgPrefs, prefsDefaults, JSON.parse(raw) || {});
    } catch (err) {
      console.warn('[SMAX Painel] smax_pg_prefs ilegivel:', err);
    }
    // Prefs gravada por versao anterior nao tem `filtros`, e o Object.assign
    // acima substitui o objeto inteiro em vez de completar os campos faltantes.
    pgPrefs.filtros = { ...prefsDefaults.filtros, ...(pgPrefs.filtros || {}) };
    ['assunto', 'base', 'competencia'].forEach((k) => {
      if (!Array.isArray(pgPrefs.filtros[k])) pgPrefs.filtros[k] = [];
    });
    /* Largura vem de storage, que versao anterior nao escreveu e que da para
     * editar a mao — entao chega aqui como `undefined`, texto ou numero absurdo.
     * O teto de 1200 nao e estetica: largura gravada de 50.000px deixaria a tabela
     * inutilizavel ja na abertura, antes de dar para alcancar o botao de
     * restaurar. O piso de 56 e o mesmo que o arraste respeita. */
    (() => {
      const lim = pgPrefs.larguras && typeof pgPrefs.larguras === 'object' ? pgPrefs.larguras : {};
      const limpo = {};
      Object.keys(lim).forEach((k) => {
        const n = Math.round(Number(lim[k]));
        if (Number.isFinite(n) && n > 0) limpo[k] = Math.max(56, Math.min(1200, n));
      });
      pgPrefs.larguras = limpo;
    })();
    /* Mesmo tratamento do `filtros` acima, pelo mesmo motivo: prefs gravada pela
     * v1.14 nao tem `monitor`, e o `Object.assign` substitui o objeto inteiro em
     * vez de completar campo faltante. O intervalo e preso a uma lista fechada
     * porque e ele que decide a carga contra o SMAX: valor editado a mao para 1
     * faria o script consultar o SMAX 60 vezes por hora, por aba. */
    (() => {
      const m = { ...prefsDefaults.monitor, ...(pgPrefs.monitor || {}) };
      const permitidos = [10, 30, 60];
      m.ligado = m.ligado !== false;
      m.notificarSO = m.notificarSO === true;
      m.minutos = permitidos.includes(Number(m.minutos)) ? Number(m.minutos) : 30;
      pgPrefs.monitor = m;
    })();
    /* As GSEs gravadas viram cláusula de filtro, concatenada na query — o
     * saneamento aqui nao e formalidade: id com aspas ou texto arbitrario iria
     * direto para dentro do `filter=`. So passa par {id numerico, nome}. */
    pgPrefs.consultaGses = (Array.isArray(pgPrefs.consultaGses) ? pgPrefs.consultaGses : [])
      .filter(g => g && /^\d+$/.test(String(g.id)) && String(g.nome || '').trim())
      .map(g => ({ id: String(g.id), nome: String(g.nome).trim() }))
      .slice(0, 30);

    const salvarDados = () => {
      try { GM_setValue(K_DADOS, JSON.stringify(dados)); }
      catch (err) { console.warn('[SMAX Painel] falha ao gravar smax_pg_dados:', err); }
    };

    const salvarPrefs = () => {
      try { GM_setValue(K_PREFS, JSON.stringify(pgPrefs)); }
      catch (err) { console.warn('[SMAX Painel] falha ao gravar smax_pg_prefs:', err); }
    };

    const substituirDados = (novo) => { dados = sanear(novo); salvarDados(); };

    /* ----- Cache do que foi lido do SMAX -----
       Descartavel: nada aqui entra no arquivo publicado. Mas tem de ser
       PERSISTIDO, nao ficar em memoria: o SMAX recarrega a pagina ao navegar
       entre telas, e cache em memoria seria perdido a cada clique do usuario na
       interface do SMAX. Foi essa armadilha que custou a v1.1 do abridor.
       Forma: { porId: { "82133910": { lidoEm, Status, ..., filhos } }, lidoEm } */
    let estado = { porId: {}, lidoEm: 0 };
    try {
      const raw = GM_getValue(K_ESTADO);
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && obj.porId && typeof obj.porId === 'object') {
        estado = { porId: obj.porId, lidoEm: Number(obj.lidoEm) || 0 };
      }
    } catch (err) {
      console.warn('[SMAX Painel] smax_pg_estado ilegivel, comecando sem cache:', err);
    }

    const salvarEstado = () => {
      try { GM_setValue(K_ESTADO, JSON.stringify(estado)); }
      catch (err) { console.warn('[SMAX Painel] falha ao gravar smax_pg_estado:', err); }
    };

    // Grava apenas os ids que a leitura cobriu. Id ausente do lote continua com o
    // que tinha — apagar aqui transformaria "nao relido agora" em "sem dado".
    //
    // O carimbo da rodada e UM so, gravado aqui tanto no estado quanto em cada
    // registro que entrou. Se cada bloco carimbasse o proprio Date.now(), todas
    // as linhas ficariam alguns milissegundos atras do carimbo geral e a tela
    // acusaria "nao relido" em quem acabou de ser lido.
    const mesclarEstado = (porId) => {
      const agora = Date.now();
      Object.entries(porId).forEach(([id, e]) => {
        estado.porId[id] = { ...e, lidoEm: agora };
      });
      estado.lidoEm = agora;
      salvarEstado();
    };

    /* ----- Novidades (fase 6) -----
       Forma: { itens: [{ id, titulo, tipo, texto, quando }], vistoEm }.
       Mais nova primeiro. `vistoEm` e o carimbo de quando o usuario olhou a
       aba — o que nao foi visto e o que conta no selo do botao flutuante.
       PERSISTIDO, e nao em memoria, por um motivo que e a razao de a fase 6
       existir: a deteccao acontece com o painel FECHADO, e o SMAX recarrega a
       pagina a cada navegacao. Novidade em memoria morreria antes de ser vista,
       e o selo mentiria. */
    let novid = { itens: [], vistoEm: 0 };
    try {
      const raw = GM_getValue(K_NOVID);
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && Array.isArray(obj.itens)) {
        novid = {
          itens: obj.itens.filter(x => x && x.id).slice(0, MAX_NOVID),
          vistoEm: Number(obj.vistoEm) || 0
        };
      }
    } catch (err) {
      console.warn('[SMAX Painel] smax_pg_novidades ilegivel, comecando vazio:', err);
    }

    const salvarNovid = () => {
      try { GM_setValue(K_NOVID, JSON.stringify(novid)); }
      catch (err) { console.warn('[SMAX Painel] falha ao gravar smax_pg_novidades:', err); }
    };

    /* Releitura do disco antes de acrescentar. Sem isto, duas abas abertas se
       sobrescreveriam: cada uma tem sua copia em memoria desde o carregamento da
       pagina, e a ultima a gravar apagaria as novidades que a outra registrou. */
    const recarregarNovid = () => {
      try {
        const raw = GM_getValue(K_NOVID);
        const obj = raw ? JSON.parse(raw) : null;
        if (obj && Array.isArray(obj.itens)) {
          novid.itens = obj.itens.filter(x => x && x.id);
          novid.vistoEm = Number(obj.vistoEm) || novid.vistoEm;
        }
      } catch { /* ilegivel: segue com o que esta em memoria */ }
    };

    const registrarNovidades = (itens) => {
      if (!itens || !itens.length) return 0;
      recarregarNovid();
      novid.itens = itens.concat(novid.itens).slice(0, MAX_NOVID);
      salvarNovid();
      return itens.length;
    };

    const marcarNovidadesVistas = () => {
      recarregarNovid();
      novid.vistoEm = Date.now();
      salvarNovid();
    };

    const limparNovidades = () => {
      novid = { itens: [], vistoEm: Date.now() };
      salvarNovid();
    };

    const naoVistas = () => {
      recarregarNovid();
      return novid.itens.filter(x => Number(x.quando) > novid.vistoEm).length;
    };

    /* ----- Agenda do monitor, compartilhada entre abas -----
       Forma: { proxima, dono, rodadaEm }.
       Mora no storage do Tampermonkey, que e COMUM as abas, e nao num
       `setInterval` por aba. Dois ganhos que nao se consegue de outra forma:
       cinco abas do SMAX abertas fazem UMA rodada, nao cinco; e recarregar a
       pagina do SMAX (o que o SMAX faz a cada navegacao) nao reinicia o relogio,
       senao quem navega muito nunca completaria um intervalo. */
    const lerAgenda = () => {
      try {
        const raw = GM_getValue(K_MON);
        const obj = raw ? JSON.parse(raw) : null;
        if (obj && typeof obj === 'object') {
          return {
            proxima: Number(obj.proxima) || 0,
            dono: String(obj.dono || ''),
            rodadaEm: Number(obj.rodadaEm) || 0
          };
        }
      } catch { /* ilegivel: trata como agenda vazia */ }
      return { proxima: 0, dono: '', rodadaEm: 0 };
    };

    const salvarAgenda = (a) => {
      try { GM_setValue(K_MON, JSON.stringify(a)); }
      catch (err) { console.warn('[SMAX Painel] falha ao gravar smax_pg_monitor:', err); }
    };

    return {
      SCHEMA,
      dados: () => dados,
      prefs: pgPrefs,
      estado: () => estado,
      novidades: () => novid,
      sanear, salvarDados, salvarPrefs, substituirDados, mesclarEstado,
      registrarNovidades, marcarNovidadesVistas, limparNovidades, naoVistas,
      lerAgenda, salvarAgenda, MAX_NOVID
    };
  })();

  /* =========================================================
   * Dados — operacoes sobre a lista curada
   *
   * Nesta fase: as tres listas de valores. Incluir/marcar/arquivar global
   * entram na fase seguinte, junto com a tela que os usa.
   * =======================================================*/
  const Dados = (() => {
    const EIXOS = [
      { chave: 'assunto', rotulo: 'Assunto', exemplo: 'Mandados' },
      { chave: 'base', rotulo: 'Base', exemplo: 'SP' },
      { chave: 'competencia', rotulo: 'Competência', exemplo: '' }
    ];

    // Caixa e acento fora da comparacao: "Mandados", "mandados" e "MANDADOS"
    // sao o MESMO valor. Sem isso a criacao livre fragmenta o eixo e o grafico
    // mostra tres barras para um tema. O nome exibido fica como foi digitado na
    // primeira vez.
    const chaveComparacao = (nome) => (nome || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();

    const limpaNome = (nome) => (nome || '').replace(/\s+/g, ' ').trim();

    const lista = (eixo) => PgStore.dados().eixos[eixo] || [];

    const nomeDe = (eixo, id) => {
      const v = lista(eixo).find(x => x.id === id);
      return v ? v.nome : '';
    };

    const acharPorNome = (eixo, nome) => {
      const k = chaveComparacao(nome);
      return k ? (lista(eixo).find(v => chaveComparacao(v.nome) === k) || null) : null;
    };

    const novoId = (eixo) => {
      const usados = new Set(lista(eixo).map(v => v.id));
      let id;
      do { id = Math.random().toString(16).slice(2, 8); } while (!id || usados.has(id));
      return id;
    };

    const criarValor = (eixo, nome) => {
      const limpo = limpaNome(nome);
      if (!limpo) return { ok: false, msg: 'Digite um nome.' };
      const existente = acharPorNome(eixo, limpo);
      if (existente) return { ok: false, valor: existente, msg: `Já existe como “${existente.nome}” — nada foi criado.` };
      const valor = { id: novoId(eixo), nome: limpo };
      lista(eixo).push(valor);
      PgStore.salvarDados();
      return { ok: true, valor, msg: `“${limpo}” criado.` };
    };

    const renomearValor = (eixo, id, nome) => {
      const limpo = limpaNome(nome);
      if (!limpo) return { ok: false, msg: 'Digite um nome.' };
      const alvo = lista(eixo).find(v => v.id === id);
      if (!alvo) return { ok: false, msg: 'Valor não encontrado.' };
      const colide = acharPorNome(eixo, limpo);
      if (colide && colide.id !== id) return { ok: false, msg: `Já existe como “${colide.nome}”.` };
      // O id nao muda: por isso renomear nao desgarra as marcacoes ja feitas.
      alvo.nome = limpo;
      PgStore.salvarDados();
      return { ok: true, msg: `Renomeado para “${limpo}”.` };
    };

    const contarUsos = (eixo, id) =>
      PgStore.dados().globais.filter(g => (g[eixo] || []).includes(id)).length;

    const removerValor = (eixo, id) => {
      const d = PgStore.dados();
      const antes = d.eixos[eixo].length;
      d.eixos[eixo] = d.eixos[eixo].filter(v => v.id !== id);
      if (d.eixos[eixo].length === antes) return { ok: false, msg: 'Valor não encontrado.' };
      // Tira a marcacao dos globais tambem: id orfao viraria marca sem rotulo.
      let limpos = 0;
      d.globais.forEach(g => {
        if ((g[eixo] || []).includes(id)) {
          g[eixo] = g[eixo].filter(x => x !== id);
          limpos++;
        }
      });
      PgStore.salvarDados();
      return { ok: true, limpos, msg: limpos ? `Removido — e desmarcado de ${limpos} global(is).` : 'Removido.' };
    };

    const acharGlobal = (id) => PgStore.dados().globais.find(g => g.id === String(id)) || null;

    // So entra marca cujo valor ainda existe na lista do eixo.
    const soValidas = (marcas, eixo) => {
      const validos = new Set(lista(eixo).map(v => v.id));
      return [...new Set((marcas && marcas[eixo]) || [])].filter(x => validos.has(x));
    };

    const incluir = (id, marcas, nota) => {
      const sid = String(id);
      if (acharGlobal(sid)) return { ok: false, msg: `#${sid} já está no painel.` };
      PgStore.dados().globais.push({
        id: sid,
        incluidoEm: new Date().toISOString().slice(0, 10),
        assunto: soValidas(marcas, 'assunto'),
        base: soValidas(marcas, 'base'),
        competencia: soValidas(marcas, 'competencia'),
        nota: (nota || '').trim(),
        arquivado: false
      });
      PgStore.salvarDados();
      return { ok: true, msg: `#${sid} incluído.` };
    };

    // Reclassificar depois da inclusao. Sem isto, errar a marcacao obrigava a
    // remover e incluir de novo — e remover apaga a nota e a data de inclusao.
    const atualizarMarcas = (id, marcas, nota) => {
      const g = acharGlobal(id);
      if (!g) return { ok: false, msg: 'Global não está no painel.' };
      g.assunto = soValidas(marcas, 'assunto');
      g.base = soValidas(marcas, 'base');
      g.competencia = soValidas(marcas, 'competencia');
      g.nota = (nota || '').trim();
      PgStore.salvarDados();
      return { ok: true, msg: `#${g.id} atualizado.` };
    };

    const arquivar = (id, valor) => {
      const g = acharGlobal(id);
      if (!g) return { ok: false, msg: 'Global não está no painel.' };
      g.arquivado = valor === true;
      PgStore.salvarDados();
      return { ok: true, msg: g.arquivado ? `#${g.id} arquivado.` : `#${g.id} reaberto no painel.` };
    };

    // Remover apaga o historico do global; arquivar e o caminho normal.
    const removerGlobal = (id) => {
      const d = PgStore.dados();
      const antes = d.globais.length;
      d.globais = d.globais.filter(g => g.id !== String(id));
      if (d.globais.length === antes) return { ok: false, msg: 'Global não está no painel.' };
      PgStore.salvarDados();
      return { ok: true, msg: `#${id} removido do painel.` };
    };

    return {
      EIXOS, chaveComparacao, lista, nomeDe, criarValor, renomearValor, removerValor, contarUsos,
      acharGlobal, incluir, atualizarMarcas, arquivar, removerGlobal
    };
  })();

  /* =========================================================
   * Metrica — lista curada + estado lido  ->  numeros
   *
   * A regra de contagem vive aqui, num lugar so. O ponto nao negociavel:
   * chamado que nao foi lido NAO e zero. `filhos: null` significa "nao lido" e a
   * tela tem de mostrar isso como tal — um painel que exibe numero e o pior
   * lugar possivel para confundir falha de leitura com ausencia de dado.
   * =======================================================*/
  const Metrica = (() => {
    // Os 8 enums de Status do Request, com o rotulo em pt-BR. O SMAX devolve o
    // enum ('RequestStatusComplete'), mas ha resposta vindo sem o prefixo —
    // normalizar nos dois sentidos para a tabela e o grafico nao discordarem.
    const STATUS_ROTULO = {
      New: 'Novo', Ready: 'Pronto', InProgress: 'Em andamento', Pending: 'Pendente',
      Suspended: 'Suspenso', Complete: 'Concluído', Rejected: 'Rejeitado', Cancelled: 'Cancelado'
    };
    // Encerrado = concluido U rejeitado U cancelado. Suspenso NAO e encerrado:
    // e o estado de "escalado, aguardando 3o nivel", ou seja, trabalho vivo.
    const ENCERRADOS = new Set(['Complete', 'Rejected', 'Cancelled']);
    const chaveStatus = (s) => String(s || '').replace(/^RequestStatus/, '');
    const rotuloStatus = (s) => STATUS_ROTULO[chaveStatus(s)] || String(s || '');

    // Recebe a LINHA, nao o status, de proposito: linha sem leitura nao tem
    // status nenhum, e `ENCERRADOS.has(chaveStatus(''))` daria `false` — ou
    // seja, "nao lido" passaria por "aberto" em silencio. Aqui nao: devolve
    // `null` para "nao se sabe", e quem chama tem de decidir o que fazer.
    const encerrada = (l) => (l.lido ? ENCERRADOS.has(chaveStatus(l.status)) : null);

    // Status operacional (`StatusSCCDSMAX_c`) e campo de lista customizado: a API
    // devolve o CODIGO ('EmAtendimento_c'), nunca o rotulo que o SMAX mostra na
    // tela. Este mapa foi transcrito do `STATUS_SCCD_LABELS` do SMAX Toolkit
    // (`SGS221-Triagem/SMAX/SMAX Toolkit - TJSP.user.js:5696-5754`), onde ja
    // estava mantido a mao; os mesmos 57 pares aparecem identicos no Respostas
    // ADM e em dois scripts de terceiro, o que e a melhor evidencia disponivel
    // de que estao certos — nao existe endpoint que devolva esses rotulos.
    const STATUS_OP_ROTULO = {
      Agendado_c:                              'Agendado',
      Aguardando3Nivel_c:                      'Aguardando 3º Nível',
      AguardandoAceiteDefinitivo_c:            'Aguardando Aceite Definitivo',
      AguardandoAceiteCancelamento_c:          'Aguardando Aceite do Cancelamento',
      AguardandoAtendimento_c:                 'Aguardando Atendimento',
      AguardandoCliente_c:                     'Aguardando Cliente',
      AguardandoClienteContato1_c:             'Aguardando Cliente – Contato 1',
      AguardandoClienteContato1DiaZero_c:      'Aguardando Cliente – Contato 1 (Dia Zero)',
      AguardandoClienteContato2_c:             'Aguardando Cliente – Contato 2',
      AguardandoClienteContato3_c:             'Aguardando Cliente – Contato 3',
      AguardandoColeta_c:                      'Aguardando Coleta',
      AguardandoContinuidadeAtendimento_c:     'Aguardando Continuidade de Atendimento',
      AguardandoDocumentacao_c:                'Aguardando Documentação',
      AguardandoEquipeConfiguracao_c:          'Aguardando Equipe de Configuração',
      AguardandoGarantiaFabricante_c:          'Aguardando Garantia do Fabricante',
      AguardandoInformacaoProcedimento_c:      'Aguardando Informação de Procedimento',
      AguardandoInstalacaoProducao_c:          'Aguardando Instalação em Produção',
      AguardandoOutraEquipe_c:                 'Aguardando Outra Equipe',
      AguardandoPeca_c:                        'Aguardando Peça',
      AguardandoRetornoCliente_c:              'Aguardando Retorno do Cliente',
      AguardandoRetornoFornecedor_c:           'Aguardando Retorno do Fornecedor',
      AguardandoSTI_c:                         'Aguardando STI',
      ATUALIZADOUSUARIOTEAMS_c:                'Atualizado pelo Usuário do Teams',
      DevolucaoFaltaSubsidio_c:                'Devolução falta de subsídio',
      DevolucaoAtendimentoIT2B_c:              'Devolução para Atendimento IT2B',
      AnaliseATIPG_c:                          'Em Análise ATIPG',
      EmAnaliseEmpresa_c:                      'Em Análise Empresa',
      AnaliseSAAB_c:                           'Em Análise SAAB',
      EmAnaliseTJSP_c:                         'Em Análise TJSP',
      EmAtendimento_c:                         'Em Atendimento',
      EmRota_c:                                'Em Rota',
      EnviaGSE_c:                              'Envia para GSE',
      EnviadoReparoExterno_c:                  'Enviado para Reparo Externo',
      EquipamentoEnviadoReparo_c:              'Equipamento Enviado para Reparo',
      ErroIntegracao_c:                        'Erro na Integração',
      Fechado_c:                               'Fechado',
      DecursoPrazo_c:                          'Fechado por Decurso de Prazo',
      DecursoDePrazo_c:                        'Fechado por Decurso de Prazo',
      GarantiaRecusada_c:                      'Garantia Recusada',
      LaudoDescarte_c:                         'Laudo para Descarte',
      MetricaAguardando_c:                     'Métricas - Aguardando',
      MetricaCancelada_c:                      'Métricas - Cancelada',
      MetricaAnalisa_c:                        'Métricas - Em Análise',
      MetricaEmExecucao_c:                     'Métricas - Em Execução',
      MetricaHomologada_c:                     'Métricas - Homologada',
      MetricaRejeitada_c:                      'Métricas - Rejeitada',
      PecaDevolvida_c:                         'Peça Devolvida',
      PecaEnviada_c:                           'Peça Enviada',
      PedidoPeca_c:                            'Pedido de Peça',
      PedidoPecaComBackup_c:                   'Pedido de Peça com Backup',
      PedidoRecategorizacao_c:                 'Pedido de Recategorização',
      RatAnexada_c:                            'Rat Anexada',
      ReparoLaboratorio_c:                     'Reparo em Laboratório',
      RetornoAnalise_c:                        'Retorno Análise',
      RetornoAtividade_c:                      'Retorno de Atividade',
      TarefaConcluidaLogista_c:                'Tarefa Concluída Logística',
      TarefaConcluidaParcialLogisti_c:         'Tarefa Concluída Parcial Logística',
    };
    // Codigo fora do mapa nao pode voltar a aparecer cru na tela: o sufixo sai e
    // o camelCase vira espaco ('EmAndamento_c' -> 'Em Andamento'). Acentua menos
    // que o mapa e erra em casos como 'Aguardando3Nivel_c', mas o mapa cobre
    // justamente esses; isto e so a rede de seguranca para codigo novo.
    const rotuloStatusOp = (s) => {
      const bruto = String(s || '').trim();
      if (!bruto) return '';
      return STATUS_OP_ROTULO[bruto]
        || bruto.replace(/_c$/i, '').replace(/([a-z0-9à-ü])([A-Z])/g, '$1 $2');
    };

    const linhaDe = (g) => {
      const e = PgStore.estado().porId[g.id] || null;
      return {
        id: g.id,
        incluidoEm: g.incluidoEm,
        nota: g.nota,
        arquivado: g.arquivado === true,
        marcas: { assunto: g.assunto || [], base: g.base || [], competencia: g.competencia || [] },
        lido: !!e,
        titulo: e ? e.titulo : '',
        status: e ? e.status : '',
        statusOp: e ? e.statusOp : '',
        grupo: e ? e.grupo : '',
        criadoEm: e ? e.criadoEm : 0,
        atualizadoEm: e ? e.atualizadoEm : 0,
        lidoEm: e ? e.lidoEm : 0,
        ehGlobal: e ? e.ehGlobal !== false : null,
        filhos: e && typeof e.filhos === 'number' ? e.filhos : null
      };
    };

    const todas = () => PgStore.dados().globais.map(linhaDe);

    const passaFiltro = (l, f) => {
      if (!f.verArquivados && l.arquivado) return false;
      if (f.soArquivados && !l.arquivado) return false;
      for (const eixo of ['assunto', 'base', 'competencia']) {
        const sel = (f[eixo] || []);
        // Multisselecao dentro do eixo e "ou"; entre eixos e "e".
        if (sel.length && !sel.some(id => l.marcas[eixo].includes(id))) return false;
      }
      if (f.status && l.status !== f.status) return false;
      if (f.termo) {
        const t = Dados.chaveComparacao(f.termo);
        const alvo = Dados.chaveComparacao(`${l.id} ${l.titulo} ${l.nota} ${l.grupo}`);
        if (!alvo.includes(t)) return false;
      }
      return true;
    };

    /* Ordenacao: estas sao funcoes de CHAVE, nao comparadores. A direcao e
     * aplicada uma unica vez em `comparador` — com comparador por coluna, cada
     * uma teria de saber inverter sozinha e a oitava esqueceria.
     * Convencao: devolver `null` quer dizer "nao se sabe" (chamado nao lido, ou
     * contagem de filhos que falhou), nunca zero nem string vazia. */
    const CHAVES = {
      numero:    l => Number(l.id),
      titulo:    l => (l.lido ? l.titulo || '' : null),
      status:    l => (l.lido ? rotuloStatus(l.status) : null),
      statusOp:  l => (l.lido ? rotuloStatusOp(l.statusOp) : null),
      grupo:     l => (l.lido ? l.grupo || '' : null),
      filhos:    l => l.filhos,
      // Quantas marcacoes tem, somando os tres eixos. Ordenar por nome nao faria
      // sentido num campo multivalorado; por quantidade responde a pergunta util,
      // que e "quais ainda estao sem classificacao".
      marcacoes: l => l.marcas.assunto.length + l.marcas.base.length + l.marcas.competencia.length,
      // Data de abertura do chamado no SMAX (CreateTime), nao a data em que
      // alguem o incluiu no painel: quem olha a lista quer saber desde quando
      // o problema existe.
      abertura:  l => l.criadoEm || null,
      atualizado: l => l.atualizadoEm || null
    };

    /* Direcao do PRIMEIRO clique na coluna. Em texto o esperado e A-Z; em numero
     * e data o esperado e o maior / mais recente primeiro. Nao da para ter uma
     * direcao padrao unica sem que metade das colunas abra ao contrario. */
    const ASC_PRIMEIRO = new Set(['titulo', 'status', 'statusOp', 'grupo']);

    const comparador = (ordem, asc) => {
      const chave = CHAVES[ordem] || CHAVES.filhos;
      const dir = asc ? 1 : -1;
      return (a, b) => {
        const va = chave(a), vb = chave(b);
        // Desconhecido vai para o fim nas DUAS direcoes. Ausencia de dado nao e
        // um valor pequeno — e a falta de um valor; inverter a ordem nao pode
        // fazer o que nao foi lido subir ao topo como se fosse resposta.
        if (va === null || vb === null) {
          if (va === vb) return 0;
          return va === null ? 1 : -1;
        }
        if (typeof va === 'string' || typeof vb === 'string') {
          return String(va).localeCompare(String(vb), 'pt-BR') * dir;
        }
        return (va - vb) * dir;
      };
    };

    const listar = (filtros, ordem, asc) =>
      todas().filter(l => passaFiltro(l, filtros || {})).sort(comparador(ordem, asc));

    const resumo = (linhas) => {
      const comFilhos = linhas.filter(l => l.filhos !== null);
      return {
        total: linhas.length,
        naoLidos: linhas.filter(l => !l.lido).length,
        semContagem: linhas.length - comFilhos.length,
        // Soma apenas o que foi lido. O "semContagem" ao lado diz quanto falta.
        filhos: comFilhos.reduce((s, l) => s + l.filhos, 0),
        // Conta sobre TODOS os curados, nao sobre as linhas filtradas: arquivado
        // fica oculto por padrao, entao contar o visivel daria sempre 0 — e "0
        // arquivados" se le como "nao arquivei nada", que e o oposto do fato.
        arquivados: todas().filter(l => l.arquivado).length,
        // Marcado no painel mas sem IsGlobal_c no SMAX: alguem desmarcou lá.
        deixaramDeSerGlobal: linhas.filter(l => l.lido && l.ehGlobal === false).length
      };
    };

    const statusConhecidos = () =>
      [...new Set(todas().map(l => l.status).filter(Boolean))]
        .sort((a, b) => rotuloStatus(a).localeCompare(rotuloStatus(b)));

    /* As agregacoes dos graficos moram aqui, junto das outras regras de
     * contagem, porque "o que esta sendo contado" e pergunta de negocio e nao
     * de desenho. Cada bloco devolve `base`, que a tela e obrigada a imprimir:
     * os eixos contam MARCACOES (um global marcado em duas bases entra nas
     * duas, entao a soma passa do total de globais) e o resto conta GLOBAIS.
     * Dois graficos na mesma tela com bases diferentes e sem rotulo se
     * contradizem sem ninguem notar. */
    const graficos = (linhas) => {
      const porEixo = Dados.EIXOS.map((e) => {
        const cont = new Map();
        linhas.forEach(l => l.marcas[e.chave].forEach((id) => {
          cont.set(id, (cont.get(id) || 0) + 1);
        }));
        return {
          chave: e.chave,
          rotulo: e.rotulo,
          base: 'marcações',
          semMarca: linhas.filter(l => !l.marcas[e.chave].length).length,
          marcacoes: [...cont.values()].reduce((s, n) => s + n, 0),
          itens: [...cont.entries()]
            .map(([id, n]) => ({ id, nome: Dados.nomeDe(e.chave, id) || id, valor: n }))
            .sort((a, b) => b.valor - a.valor || a.nome.localeCompare(b.nome))
        };
      });

      // Só quem tem contagem confiavel entra. Global sem leitura nao e barra de
      // altura zero — ficaria indistinguivel de global que nao absorveu nada.
      const comFilhos = linhas.filter(l => l.filhos !== null);
      const filhos = {
        base: 'filhos',
        semContagem: linhas.length - comFilhos.length,
        itens: comFilhos
          .map(l => ({ id: l.id, nome: `#${l.id}`, titulo: l.titulo, valor: l.filhos }))
          .sort((a, b) => b.valor - a.valor || Number(b.id) - Number(a.id))
      };

      // Tres baldes, nao dois: global sem leitura NAO pode cair em "aberto" por
      // omissao — seria afirmar que o chamado esta vivo sem ter lido nada dele.
      const vida = { abertos: 0, encerrados: 0, indefinidos: 0 };
      linhas.forEach((l) => {
        if (!l.lido || !l.status) vida.indefinidos++;
        else if (ENCERRADOS.has(chaveStatus(l.status))) vida.encerrados++;
        else vida.abertos++;
      });

      const porMes = new Map();
      let semData = 0;
      linhas.forEach((l) => {
        if (!l.criadoEm) { semData++; return; }
        const d = new Date(l.criadoEm);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        porMes.set(k, (porMes.get(k) || 0) + 1);
      });
      // Meses sem nenhum global entram com zero. Sem isso, uma lacuna de dois
      // meses encosta as barras vizinhas e a linha do tempo passa a mentir.
      const chaves = [...porMes.keys()].sort();
      const serie = [];
      if (chaves.length) {
        const [ay, am] = chaves[0].split('-').map(Number);
        const [by, bm] = chaves[chaves.length - 1].split('-').map(Number);
        for (let y = ay, m = am; y < by || (y === by && m <= bm); m === 12 ? (m = 1, y++) : m++) {
          const k = `${y}-${String(m).padStart(2, '0')}`;
          serie.push({
            id: k,
            nome: `${String(m).padStart(2, '0')}/${String(y).slice(2)}`,
            valor: porMes.get(k) || 0
          });
        }
      }

      return {
        porEixo,
        filhos,
        vida: { base: 'globais', ...vida },
        meses: { base: 'globais', semData, itens: serie }
      };
    };

    return { todas, listar, resumo, statusConhecidos, graficos, rotuloStatus, rotuloStatusOp, encerrada, CHAVES, ASC_PRIMEIRO };
  })();

  /* =========================================================
   * GitSync — publicar e importar o arquivo do painel
   *
   * Escreve quem tem token; le quem tem a URL. Arquivo PROPRIO, nunca o
   * shared-config.json do Respostas: o publicador de lá faz o merge sobre um
   * cache de uma hora (Respostas ADM:4295) e, com o cache vencido ou vazio,
   * apaga chave gravada por outro script. Aqui a base do merge e o conteudo do
   * mesmo GET que traz o SHA.
   * =======================================================*/
  const GitSync = (() => {
    const parseRawUrl = (url) => {
      const m = (url || '').trim()
        .match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      return m ? { owner: m[1], repo: m[2], branch: m[3], path: m[4] } : null;
    };

    const ghHeaders = (token) => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    });

    const req = (opts) => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: 20000,
        ...opts,
        onload: resolve,
        onerror: () => reject(new Error('erro de rede')),
        ontimeout: () => reject(new Error('tempo esgotado'))
      });
    });

    const deB64 = (s) => decodeURIComponent(escape(atob((s || '').replace(/\s/g, ''))));
    const paraB64 = (s) => btoa(unescape(encodeURIComponent(s)));

    // Leitura publica, sem token: e por aqui que as outras pessoas importam.
    // ?_t= fura cache de CDN, igual ao SharedConfig do Respostas (:10287+).
    const lerPeloRaw = async (url) => {
      const res = await req({ method: 'GET', url: `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}` });
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`HTTP ${res.status} ao baixar o arquivo.`);
      try { return JSON.parse(res.responseText); }
      catch { throw new Error('O arquivo baixado não é um JSON válido.'); }
    };

    // Leitura pela API: devolve o SHA (obrigatorio para gravar) e o conteudo do
    // MESMO instante. E este conteudo que serve de base do merge.
    const lerPelaApi = async (loc, token) => {
      const url = `https://api.github.com/repos/${loc.owner}/${loc.repo}/contents/${loc.path}?ref=${encodeURIComponent(loc.branch)}`;
      const res = await req({ method: 'GET', url, headers: ghHeaders(token) });
      if (res.status === 404) return { sha: '', remoto: null };   // arquivo ainda nao existe
      if (res.status !== 200) {
        let detalhe = '';
        try { detalhe = JSON.parse(res.responseText).message || ''; } catch { }
        throw new Error(`HTTP ${res.status} ao ler o arquivo${detalhe ? ': ' + detalhe : ''}.`);
      }
      const meta = JSON.parse(res.responseText);
      let remoto;
      try { remoto = JSON.parse(deB64(meta.content)); }
      catch { throw new Error('O arquivo no GitHub não é um JSON válido — corrija lá antes de publicar.'); }
      return { sha: meta.sha || '', remoto };
    };

    const checaSchema = (obj) => {
      const s = Number(obj && obj._schema) || 1;
      if (s > PgStore.SCHEMA) {
        throw new Error(`O arquivo foi gravado por uma versão mais nova do script (formato ${s}; este entende ${PgStore.SCHEMA}). Atualize o script antes.`);
      }
      return s;
    };

    // Assinatura do que uma pessoa decidiu sobre um global. Serve para contar
    // quantos mudaram na previa da importacao.
    const assinatura = (g) =>
      Dados.EIXOS.map(e => (g[e.chave] || []).slice().sort().join(',')).join('|')
      + `|${g.nota || ''}|${g.arquivado === true}`;

    const diff = (local, remotoSan) => {
      const lg = new Map(local.globais.map(g => [g.id, g]));
      const rg = new Map(remotoSan.globais.map(g => [g.id, g]));
      const eixos = Dados.EIXOS.map(e => {
        const lv = new Map(local.eixos[e.chave].map(v => [v.id, v.nome]));
        const rv = new Map(remotoSan.eixos[e.chave].map(v => [v.id, v.nome]));
        return {
          rotulo: e.rotulo,
          entram: [...rv.keys()].filter(id => !lv.has(id)).length,
          saem: [...lv.keys()].filter(id => !rv.has(id)).length,
          renomeados: [...rv.keys()].filter(id => lv.has(id) && lv.get(id) !== rv.get(id)).length
        };
      });
      return {
        versaoLocal: local._version,
        versaoRemota: remotoSan._version,
        entram: [...rg.keys()].filter(id => !lg.has(id)),
        saem: [...lg.keys()].filter(id => !rg.has(id)),
        mudam: [...rg.keys()].filter(id => lg.has(id) && assinatura(lg.get(id)) !== assinatura(rg.get(id))),
        eixos
      };
    };

    // Devolve a previa. NAO aplica — aplicar e um segundo passo explicito,
    // porque substituir o dado curado sem mostrar o que muda e a forma mais
    // facil de perder trabalho.
    const prepararImportacao = async () => {
      const url = (PgStore.prefs.arquivoUrl || '').trim();
      if (!parseRawUrl(url)) throw new Error('A URL deve ser https://raw.githubusercontent.com/{dono}/{repo}/{branch}/{caminho}.');
      const remoto = await lerPeloRaw(url);
      if (!remoto) throw new Error('Não existe arquivo nesse caminho ainda. Publique uma vez primeiro.');
      checaSchema(remoto);
      const remotoSan = PgStore.sanear(remoto);
      return { remotoSan, previa: diff(PgStore.dados(), remotoSan) };
    };

    const aplicarImportacao = (remotoSan) => { PgStore.substituirDados(remotoSan); };

    const publicar = async (onStatus) => {
      const token = (PgStore.prefs.githubToken || '').trim();
      const loc = parseRawUrl(PgStore.prefs.arquivoUrl);
      if (!loc) throw new Error('A URL deve ser https://raw.githubusercontent.com/{dono}/{repo}/{branch}/{caminho}.');
      if (!token) throw new Error('Informe o token do GitHub para publicar.');

      onStatus('Lendo o arquivo atual no GitHub…');
      const { sha, remoto } = await lerPelaApi(loc, token);
      if (remoto) checaSchema(remoto);

      const local = PgStore.dados();
      const versaoRemota = remoto ? (Number(remoto._version) || 0) : 0;

      // Trava otimista. O usuario trabalha em mais de um computador: publicar
      // sobre uma versao mais nova apagaria o que a outra maquina gravou. Mesmo
      // papel do LastUpdateTime nas escritas do SMAX.
      if (versaoRemota > local._version) {
        const err = new Error(`O GitHub está na versão ${versaoRemota} e esta máquina na ${local._version}: outra máquina publicou depois. Importe primeiro para não apagar o que foi feito lá.`);
        err.desatualizado = true;
        throw err;
      }

      const corpo = {
        ...(remoto || {}),              // preserva chave que este script nao conhece
        ...local,                       // o que esta maquina decidiu vence
        _schema: PgStore.SCHEMA,
        _version: versaoRemota + 1,
        _updatedAt: new Date().toISOString().slice(0, 10)
      };

      onStatus('Publicando…');
      const res = await req({
        method: 'PUT',
        url: `https://api.github.com/repos/${loc.owner}/${loc.repo}/contents/${loc.path}`,
        headers: ghHeaders(token),
        data: JSON.stringify({
          message: `chore: atualiza painel-globais v${corpo._version}`,
          content: paraB64(JSON.stringify(corpo, null, 2)),
          branch: loc.branch,
          ...(sha ? { sha } : {})
        })
      });
      if (res.status !== 200 && res.status !== 201) {
        let detalhe = '';
        try { detalhe = JSON.parse(res.responseText).message || ''; } catch { }
        throw new Error(`HTTP ${res.status}${detalhe ? ': ' + detalhe : ''}`);
      }

      // So depois do PUT aceito a copia local passa a valer como publicada.
      local._version = corpo._version;
      local._updatedAt = corpo._updatedAt;
      PgStore.salvarDados();
      return corpo._version;
    };

    return { parseRawUrl, prepararImportacao, aplicarImportacao, publicar };
  })();

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

    /* `DOMParser` e nao `div.innerHTML`: o documento que o DOMParser devolve e
     * INERTE — nao busca recurso nem dispara evento. Num div solto, mesmo fora
     * do documento, o Chrome ainda tenta carregar `<img src>`, e um
     * `<img src=x onerror=...>` roda antes desta funcao chegar a tirar o
     * atributo. Isso era aceitavel enquanto a entrada era so o que o proprio
     * usuario digitava no editor; deixou de ser quando o visualizador de chamado
     * passou a renderizar descricao escrita por qualquer solicitante. */
    const sanitizeRichText = (html) => {
      if (!html) return '';
      const tmp = new DOMParser().parseFromString(String(html), 'text/html').body;
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

    /* O SMAX devolve `Description` e `Comments` as vezes com o HTML escapado
     * DUAS vezes: chega `&lt;p&gt;texto&lt;/p&gt;` em vez de `<p>texto</p>`, e
     * renderizar isso direto mostra as tags como texto na tela
     * (Automacoes-compiladas.user.js:977-990 trata o mesmo caso com `<textarea>`;
     * aqui o DOMParser faz o mesmo e e inerte).
     * Decide pelo conteudo, nao por configuracao: so desescapa se NAO houver tag
     * de verdade e houver entidade que pareca tag. Desescapar sempre quebraria o
     * caso normal, em que `&lt;` no meio do texto e literalmente o sinal de menor
     * que alguem digitou. */
    const unescapeIfDoubleEscaped = (html) => {
      const s = String(html || '');
      if (!s) return '';
      if (/<[a-z!/]/i.test(s)) return s;
      if (!/&lt;\s*\/?[a-z]/i.test(s)) return s;
      return new DOMParser().parseFromString(s, 'text/html').body.textContent || '';
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

    const formatBrDate = (ts) => {
      if (!ts) return '—';
      try {
        return new Date(ts).toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric'
        });
      } catch { return '—'; }
    };

    return {
      escapeHtml, sanitizeRichText, normalizeContentEditableHtml, htmlToText,
      unescapeIfDoubleEscaped, deepClone, onDomReady, formatBrDateTime, formatBrDate
    };
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
   * PgApi — as leituras do painel no SMAX
   *
   * Leituras, e so leituras — nenhuma escrita: a conferencia de um chamado na
   * hora de incluir, o estado dos globais marcados, a contagem de filhos, a
   * sondagem barata dessa contagem (fase 6) e o chamado inteiro para o
   * visualizador.
   * =======================================================*/
  const PgApi = (() => {
    // GlobalId_c volta como OBJETO { Id: "82133910" } e pode estar em
    // properties OU em related_properties
    // (Automacoes-compiladas.user.js:1052-1053, :1296).
    const extrairGlobalId = (valor) => {
      if (valor === null || valor === undefined || valor === '') return '';
      const bruto = typeof valor === 'object' ? (valor.Id || valor.id || '') : valor;
      const s = String(bruto).replace(/^IM(Rfc|chg):/i, '').replace(/\D+/g, '');
      return /^\d{3,}$/.test(s) ? s : '';
    };

    // Uma leitura barata que responde tres coisas de uma vez: o chamado existe,
    // ele E global, e ele nao e filho de outro.
    const conferir = async (id) => {
      let resp;
      try {
        resp = await ApiClient.request(`ems/Request/${encodeURIComponent(id)}`, {
          searchParams: { layout: 'Id,IsGlobal_c,GlobalId_c,DisplayLabel' }
        });
      } catch (err) {
        // 404 e "nao existe". Qualquer outra falha e "nao consegui ler", que e
        // coisa diferente e nao pode virar uma recusa por inexistencia.
        if (err.status === 404) return { estado: 'inexistente' };
        throw err;
      }

      const ent = (resp && resp.entities && resp.entities[0]) || null;
      const props = (ent && ent.properties) || (resp && resp.properties) || null;
      if (!props || !props.Id) return { estado: 'inexistente' };

      const rel = (ent && ent.related_properties) || (resp && resp.related_properties) || {};
      const ig = props.IsGlobal_c;
      const sid = String(props.Id);
      const bruto = (props.GlobalId_c !== undefined && props.GlobalId_c !== null)
        ? props.GlobalId_c : rel.GlobalId_c;
      const pai = extrairGlobalId(bruto);

      return {
        estado: 'lido',
        id: sid,
        titulo: props.DisplayLabel || '',
        ehGlobal: ig === true || ig === 'true' || ig === 1 || ig === '1',
        // Auto-referencia nao e vinculo de pai.
        paiId: pai && pai !== sid ? pai : ''
      };
    };

    // Concorrencia limitada a 6, o mesmo que o pesquisa-avancada-smax usa (:101).
    const emLote = async (ids, fn, limite = 6) => {
      const saida = new Array(ids.length);
      let proximo = 0;
      const trabalhador = async () => {
        while (proximo < ids.length) {
          const i = proximo++;
          saida[i] = await fn(ids[i], i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limite, ids.length) }, trabalhador));
      return saida;
    };

    /* ---------- As duas leituras em lote do painel ---------- */

    const BLOCO_IDS = 50;   // ids por requisicao — limite pratico e o tamanho da URL
    const PAGINA = 250;     // registros por pagina

    const LAYOUT_ESTADO = [
      'Id', 'DisplayLabel', 'Status', 'StatusSCCDSMAX_c', 'PhaseId',
      'AssignedToGroup', 'AssignedToGroup.Name', 'CreateTime', 'LastUpdateTime', 'IsGlobal_c'
    ].join(',');

    const emBlocos = (arr, n) => {
      const out = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };

    // A cadeia de "or" vai entre parenteses PROPRIOS. A precedencia de and/or nos
    // filtros do SMAX nao esta documentada, e a falha e silenciosa: registros
    // com campo nulo simplesmente nao voltam. Mesmo cuidado do
    // Monitor-de-solicitacoes.user.js:129.
    const clausulaOu = (campo, ids) => ids.length === 1
      ? `${campo} = '${ids[0]}'`
      : `(${ids.map(i => `${campo} = '${i}'`).join(' or ')})`;

    // O SMAX recusa a consulta ao passar de 10.000 entidades MESMO pedindo 1
    // registro (Extração:1232). Sem dizer isso, parece que nao ha resultado.
    const motivoDeErro = (err) => {
      if (/query\.num\.of\.entities\.exceeded/.test((err && err.body) || '')) {
        return 'a consulta passou do teto de 10.000 registros do SMAX';
      }
      if (err && err.name === 'AbortError') return 'tempo esgotado';
      return (err && err.message) || 'erro desconhecido';
    };

    // Le pagina por pagina ate cobrir o total_count. Sem isso um lote grande
    // volta truncado e o painel mostraria um numero menor como se fosse fato.
    const lerPaginas = async (filtro, layout) => {
      const entidades = [];
      let skip = 0;
      for (let volta = 0; volta < 200; volta++) {
        const resp = await ApiClient.request('ems/Request', {
          timeout: 45000,
          searchParams: {
            filter: filtro, layout, size: String(PAGINA),
            skip: String(skip), meta: 'totalCount'
          }
        });
        if (resp && resp.meta && resp.meta.completion_status
            && String(resp.meta.completion_status).toUpperCase() !== 'OK') {
          const err = new Error('consulta recusada pelo SMAX');
          err.body = JSON.stringify(resp);
          throw err;
        }
        const lote = (resp && resp.entities) || [];
        entidades.push(...lote);
        const total = Number(resp && resp.meta && resp.meta.total_count);
        skip += lote.length;
        if (!lote.length || !Number.isFinite(total) || entidades.length >= total) break;
      }
      return entidades;
    };

    const ehVerdadeiro = (v) => v === true || v === 'true' || v === 1 || v === '1';

    // Um unico global problematico — p.ex. um com filhos acima do teto de 10.000
    // — faz o SMAX recusar a consulta do BLOCO inteiro. Sem isto, um global ruim
    // deixaria os outros 49 do bloco sem atualizar para sempre, e justo os globais
    // gigantes sao os que a equipe mais acompanha. Ao falhar, parte o bloco ao
    // meio e tenta de novo, ate chegar no culpado: so ele fica marcado como falha.
    const porPartes = async (bloco, tentar) => {
      try {
        await tentar(bloco);
        return [];
      } catch (err) {
        if (bloco.length === 1) return [{ ids: bloco, motivo: motivoDeErro(err) }];
        const meio = Math.ceil(bloco.length / 2);
        const esq = await porPartes(bloco.slice(0, meio), tentar);
        const dir = await porPartes(bloco.slice(meio), tentar);
        return esq.concat(dir);
      }
    };

    // (1) Estado dos globais marcados.
    const lerEstado = async (ids, onProgresso) => {
      const blocos = emBlocos(ids, BLOCO_IDS);
      const porId = {};
      const falhas = [];
      let feitos = 0;
      await emLote(blocos, async (bloco) => {
        const falhou = await porPartes(bloco, async (parte) => {
          const ents = await lerPaginas(clausulaOu('Id', parte), LAYOUT_ESTADO);
          ents.forEach((e) => {
            const p = (e && e.properties) || {};
            const rel = (e && e.related_properties) || {};
            if (!p.Id) return;
            // Sem `lidoEm` aqui de proposito: quem carimba a hora e o
            // PgStore.mesclarEstado, com um carimbo unico para a rodada toda.
            porId[String(p.Id)] = {
              titulo: String(p.DisplayLabel || ''),
              status: String(p.Status || ''),
              statusOp: String(p.StatusSCCDSMAX_c || ''),
              fase: String(p.PhaseId || ''),
              grupo: String(
                (rel.AssignedToGroup && rel.AssignedToGroup.Name)
                || (p.AssignedToGroup && p.AssignedToGroup.Name)
                || p['AssignedToGroup.Name']
                || p.AssignedToGroup || ''
              ),
              criadoEm: Number(p.CreateTime) || 0,
              atualizadoEm: Number(p.LastUpdateTime) || 0,
              ehGlobal: ehVerdadeiro(p.IsGlobal_c)
            };
          });
        });
        // Quem sobrou aqui nao foi relido. Guardar quais, para a tela poder dizer
        // "nao lido" nesses — e nao zero.
        falhas.push(...falhou);
        feitos++;
        if (onProgresso) onProgresso(feitos, blocos.length);
      });
      return { porId, falhas };
    };

    // (2) Quantos filhos cada global absorveu. Uma consulta por bloco de pais,
    // nao uma por global. RequestCausesRequest devolve 403 em consulta direta;
    // o caminho que funciona e filtrar por GlobalId_c (seção 19.6).
    const contarFilhos = async (ids, onProgresso) => {
      const blocos = emBlocos(ids, BLOCO_IDS);
      const porPai = {};
      const falhas = [];
      ids.forEach((id) => { porPai[id] = 0; });
      let feitos = 0;
      await emLote(blocos, async (bloco) => {
        const falhou = await porPartes(bloco, async (parte) => {
          const ents = await lerPaginas(clausulaOu('GlobalId_c', parte), 'Id,GlobalId_c');
          ents.forEach((e) => {
            const p = (e && e.properties) || {};
            const rel = (e && e.related_properties) || {};
            const bruto = (p.GlobalId_c !== undefined && p.GlobalId_c !== null)
              ? p.GlobalId_c : rel.GlobalId_c;
            const pai = extrairGlobalId(bruto);
            // Auto-referencia nao conta como filho.
            if (!pai || pai === String(p.Id)) return;
            if (porPai[pai] === undefined) return;
            porPai[pai]++;
          });
        });
        // Sem contagem confiavel: tirar a chave para a tela mostrar "nao lido",
        // nunca 0 — um global com teto estourado tem MUITOS filhos, nao nenhum.
        falhou.forEach((f) => f.ids.forEach((id) => { delete porPai[id]; }));
        falhas.push(...falhou);
        feitos++;
        if (onProgresso) onProgresso(feitos, blocos.length);
      });
      return { porPai, falhas };
    };

    /* (2b) A SONDAGEM do monitor: quantos filhos, sem trazer os filhos.
     *
     * Por que existe uma segunda forma de contar. A de cima (`contarFilhos`)
     * ENUMERA: ela traz todos os registros filhos para atribuir cada um ao seu
     * pai, o que e necessario porque ela pergunta por 50 pais de uma vez. O custo
     * disso ficou visivel no global 86606075, medido em 2026-10-09: 2.614 filhos
     * sao 11 requisicoes de 250 registros para UM global. Num ciclo automatico
     * isso e carga demais contra o SMAX.
     *
     * Aqui a pergunta e outra — "o numero mudou?" — e para ela basta
     * `size=1&meta=totalCount`: uma requisicao por global, payload praticamente
     * zero, que e justo a consulta recomendada na secao 22.5 item 3 da analise.
     *
     * ⚠️ O numero daqui NAO vai para a tela, e o motivo e sutil: `total_count`
     * conta o registro do proprio global quando ele tem `GlobalId_c` apontando
     * para si mesmo, e a enumeracao desconta essa autorreferencia (:1356). As
     * duas contagens podem portanto diferir em 1. Entao este valor e guardado
     * num campo PROPRIO (`filhosSonda`) e comparado sempre contra ele mesmo —
     * marca d'agua, nao informacao. Quem a tela mostra continua sendo `filhos`,
     * da enumeracao. Comparar metricas diferentes faria o primeiro ciclo
     * anunciar "+1 filho" em todo global autorreferente, que e exatamente o tipo
     * de mentira que este painel nao pode contar. */
    const TOTAL_KEYS = ['total_count', 'totalCount'];

    /* `total_count` vem em ate 5 grafias diferentes no SMAX (analise §18.2 item
     * 20). Ler so `meta.total_count` funciona hoje e falha calado amanha: o
     * numero viria `undefined`, a sondagem nao veria mudanca nenhuma e o monitor
     * simplesmente nunca avisaria nada. */
    const lerTotal = (resp) => {
      const fontes = [resp, resp && resp.meta, resp && resp.metadata, resp && resp.Query];
      for (const f of fontes) {
        if (!f) continue;
        for (const k of TOTAL_KEYS) {
          const n = Number(f[k]);
          if (Number.isFinite(n) && n >= 0) return n;
        }
      }
      return null;
    };

    const sondarFilhos = async (ids) => {
      const porPai = {};
      const falhas = [];
      // Uma requisicao por global, em paralelo controlado — o mesmo limite que o
      // resto do script usa para nao abrir 50 conexoes de uma vez.
      await emLote(ids, async (id) => {
        try {
          const resp = await ApiClient.request('ems/Request', {
            timeout: 30000,
            searchParams: {
              filter: `GlobalId_c = '${id}'`, layout: 'Id',
              size: '1', skip: '0', meta: 'totalCount'
            }
          });
          if (resp && resp.meta && resp.meta.completion_status
              && String(resp.meta.completion_status).toUpperCase() !== 'OK') {
            const err = new Error('consulta recusada pelo SMAX');
            err.body = JSON.stringify(resp);
            throw err;
          }
          const n = lerTotal(resp);
          // Sem total legivel nao se inventa zero: fica como falha, e a sondagem
          // trata o global como "nao sei", nao como "nao tem filho".
          if (n === null) throw new Error('resposta sem total_count');
          porPai[id] = n;
        } catch (err) {
          falhas.push({ ids: [id], motivo: motivoDeErro(err) });
        }
      });
      return { porPai, falhas };
    };

    /* (3) O chamado inteiro, para o visualizador.
     *
     * NAO usa `ems/Request/{id}?layout=Description,Solution,Comments`. Esse e o
     * caminho obvio e ele falha em silencio: devolve os tres campos VAZIOS em
     * parte dos chamados que claramente tem conteudo — o proprio Leonardo
     * documentou isso em smax-extracao-avancada.user.js:1591-1596 e trocou pelo
     * endpoint que a tela nativa do chamado usa, que e este. Preferir o endpoint
     * da tela nativa tem o efeito colateral bom de ser o que o SMAX mais testa.
     *
     * Os dois layouts vao juntos de proposito: `withoutResolution` traz os campos
     * do chamado e `onlyResolution` traz a solucao; pedir so o primeiro devolve
     * a solucao vazia, o que e indistinguivel de "nao tem solucao".
     *
     * Armadilha da forma da resposta: o dado vem em `EntityData.properties`, e
     * NAO em `properties` como nos outros endpoints. As tres formas abaixo sao as
     * que o Leonardo aceita (:1600-1606) — ele viu as tres em producao. */
    const LAYOUTS_FORM = 'FORM_LAYOUT.withoutResolution,FORM_LAYOUT.onlyResolution';

    const propsDoForm = (resp) => (resp && resp.EntityData && resp.EntityData.properties)
      || (resp && resp.properties)
      || (resp && Array.isArray(resp.entities) && resp.entities[0] && resp.entities[0].properties)
      || null;

    /* `Comments` nao e array: e uma STRING com um JSON dentro, na forma
     * {"Comment":[{Submitter,IsSystem,CommentBody,CreateTime,PrivacyType}]}.
     * JSON invalido aqui nao pode derrubar o modal inteiro — descricao e solucao
     * continuam valendo —, entao a falha vira lista vazia e um aviso. */
    const parseComentarios = (bruto) => {
      if (!bruto) return { itens: [], erro: '' };
      let obj = bruto;
      if (typeof bruto === 'string') {
        try { obj = JSON.parse(bruto); }
        catch { return { itens: [], erro: 'A discussão veio num formato que não foi possível interpretar.' }; }
      }
      const arr = Array.isArray(obj) ? obj : (Array.isArray(obj && obj.Comment) ? obj.Comment : []);
      const itens = arr
        .filter(c => c && c.IsSystem !== true && c.IsSystem !== 'true')
        .map(c => ({
          corpo: String(c.CommentBody || ''),
          autorId: String(c.Submitter || '').replace(/^Person\//, ''),
          quando: Number(c.CreateTime) || 0,
          // PrivacyType 'INTERNAL' e o comentario que o solicitante NAO ve. Tem de
          // aparecer marcado: quem le o modal pode estar prestes a copiar isso
          // para uma resposta publica.
          interno: String(c.PrivacyType || '').toUpperCase() === 'INTERNAL'
        }))
        .sort((a, b) => a.quando - b.quando);
      return { itens, erro: '' };
    };

    const lerChamado = async (id) => {
      const resp = await ApiClient.request(
        `entity-page/initializationDataByLayout/Request/${encodeURIComponent(id)}`,
        { searchParams: { layout: LAYOUTS_FORM }, timeout: 45000 }
      );
      const p = propsDoForm(resp);
      if (!p || !p.Id) {
        const err = new Error('A resposta do SMAX não trouxe os dados do chamado.');
        err.formaInesperada = true;
        throw err;
      }
      const rel = (resp && resp.EntityData && resp.EntityData.related_properties) || {};
      const disc = parseComentarios(p.Comments);
      return {
        id: String(p.Id),
        titulo: String(p.DisplayLabel || ''),
        status: String(p.Status || ''),
        statusOp: String(p.StatusSCCDSMAX_c || ''),
        grupo: String(
          (rel.AssignedToGroup && rel.AssignedToGroup.Name)
          || (p.AssignedToGroup && p.AssignedToGroup.Name)
          || p['AssignedToGroup.Name'] || ''
        ),
        criadoEm: Number(p.CreateTime) || 0,
        atualizadoEm: Number(p.LastUpdateTime) || 0,
        descricao: String(p.Description || ''),
        solucao: String(p.Solution || ''),
        comentarios: disc.itens,
        erroDiscussao: disc.erro
      };
    };

    /* ---------- (5) A consulta: achar globais que ja estao abertos ----------
     *
     * As outras leituras partem de uma lista de ids que o usuario ja tem. Esta
     * nao: ela PROCURA. E a peca que faltava para incluir um global sem saber o
     * numero dele de cabeca.
     *
     * Funcao separada do `lerPaginas` de proposito. O `lerPaginas` pagina ate
     * cobrir o `total_count` inteiro porque o painel precisa do numero exato de
     * filhos; aqui isso seria hostil — 10.000 globais dariam 40 requisicoes para
     * o usuario ler as 20 primeiras linhas. Aqui pagina sob demanda, e o
     * `lerPaginas` (caminho do monitor, verificado) fica intocado.
     */

    // Os 8 enums de Status, partidos em vivos e encerrados. Mesma divisao do
    // `Metrica.ENCERRADOS` (:564) — Suspenso conta como vivo.
    const STATUS_VIVOS = ['New', 'Ready', 'InProgress', 'Pending', 'Suspended'];
    const STATUS_FIM = ['Complete', 'Rejected', 'Cancelled'];

    const LAYOUT_BUSCA = [
      'Id', 'DisplayLabel', 'Status', 'StatusSCCDSMAX_c',
      'AssignedToGroup', 'AssignedToGroup.Name', 'CreateTime', 'LastUpdateTime',
      // ExpertGroup entra so para DIAGNOSTICO: o filtro de GSE e por
      // `AssignedToGroup` (e o que o script do Leonardo filtra em producao,
      // :1346), mas quem troca de GSE no SMAX Respostas grava `ExpertGroup`.
      // Se nesta instalacao a GSE do global morar no outro campo, a linha mostra
      // a divergencia em vez de a consulta voltar vazia sem explicacao.
      'ExpertGroup', 'ExpertGroup.Name',
      // GlobalId_c entra no layout para o descarte de filho acontecer aqui, no
      // cliente: "nao ser filho de outro global" nao e expressavel no filtro.
      'GlobalId_c', 'IsGlobal_c'
    ].join(',');

    // Monta o filtro. Booleano vai ENTRE ASPAS e epoch vai SEM — as duas formas
    // foram lidas em codigo de producao de terceiro (pesquisa-avancada-smax
    // .user.js:3596 e :1330), nao supostas. O campo `IsGlobal_c` e filtravel no
    // servidor: a propria tela de filtro do SMAX o oferece como campo
    // (`data-aid="filter_field_IsGlobal_c"`, "é Global").
    const filtroBusca = ({ desde = 0, situacao = 'abertos', grupos = [] } = {}) => {
      const partes = [`IsGlobal_c = 'true'`];
      if (desde) partes.push(`CreateTime >= ${Math.floor(desde)}`);
      // GSE por Id, entre aspas — forma lida em producao
      // (pesquisa-avancada-smax.user.js:1346, que filtra exatamente isto). Nada
      // de nome: nome muda e tem acento, Id nao. Recortar por GSE tambem afasta
      // o teto de 10.000, que e o que torna "sem recorte" de data utilizavel.
      const gses = [...new Set(grupos.map(String).filter(g => /^\d+$/.test(g)))];
      if (gses.length) partes.push(clausulaOu('AssignedToGroup', gses));
      // Lista OR positiva, nunca `!=`: a negacao nao foi vista em nenhum filtro
      // de producao, e filtro recusado pelo SMAX falha em silencio (volta vazio,
      // que a tela leria como "nao existe nenhum").
      const enums = situacao === 'abertos' ? STATUS_VIVOS
        : situacao === 'encerrados' ? STATUS_FIM : [];
      if (enums.length) partes.push(clausulaOu('Status', enums.map(s => `RequestStatus${s}`)));
      return partes.join(' and ');
    };

    const PAGINA_BUSCA = 250;

    // Conta antes de buscar. Uma requisicao de 1 registro responde "quantos
    // existem", e e isso que deixa a tela dizer o tamanho do resultado antes de
    // gastar 250 linhas de payload.
    // Quem falha tem de dizer COM QUE filtro falhou. Sem isto a tela so sabe o
    // filtro quando a consulta deu certo — e e justamente na recusa que a string
    // exata precisa aparecer, porque e ela que diz se a forma do literal esta
    // errada.
    const comFiltro = async (filtro, fn) => {
      try { return await fn(); }
      catch (err) { err.filtro = filtro; throw err; }
    };

    const contarBusca = async (opcoes) => {
      const filtro = filtroBusca(opcoes);
      const resp = await comFiltro(filtro, () => ApiClient.request('ems/Request', {
        timeout: 45000,
        searchParams: { filter: filtro, layout: 'Id', size: '1', skip: '0', meta: 'totalCount' }
      }));
      const total = Number(resp && resp.meta && resp.meta.total_count);
      return { filtro, total: Number.isFinite(total) ? total : 0 };
    };

    // Uma pagina. `order` no servidor (pesquisa-avancada-smax.user.js:1587) —
    // sem isso o SMAX devolve na ordem dele e "mais recentes primeiro" teria de
    // ser mentira ou ordenacao de um pedaco arbitrario.
    const buscarPagina = async (opcoes = {}) => {
      const { skip = 0 } = opcoes;
      const filtro = filtroBusca(opcoes);
      const resp = await comFiltro(filtro, () => ApiClient.request('ems/Request', {
        timeout: 45000,
        searchParams: {
          filter: filtro, layout: LAYOUT_BUSCA, order: 'CreateTime desc',
          size: String(PAGINA_BUSCA), skip: String(skip), meta: 'totalCount'
        }
      }));
      if (resp && resp.meta && resp.meta.completion_status
          && String(resp.meta.completion_status).toUpperCase() !== 'OK') {
        const err = new Error('consulta recusada pelo SMAX');
        err.body = JSON.stringify(resp);
        err.filtro = filtro;
        throw err;
      }
      const total = Number(resp && resp.meta && resp.meta.total_count);
      const brutos = (resp && resp.entities) || [];
      const itens = brutos.map((e) => {
        const p = (e && e.properties) || {};
        const rel = (e && e.related_properties) || {};
        const id = String(p.Id || '');
        const bruto = (p.GlobalId_c !== undefined && p.GlobalId_c !== null)
          ? p.GlobalId_c : rel.GlobalId_c;
        const pai = extrairGlobalId(bruto);
        return {
          id,
          titulo: String(p.DisplayLabel || ''),
          status: String(p.Status || ''),
          statusOp: String(p.StatusSCCDSMAX_c || ''),
          grupo: String(
            (rel.AssignedToGroup && rel.AssignedToGroup.Name)
            || (p.AssignedToGroup && p.AssignedToGroup.Name)
            || p['AssignedToGroup.Name'] || p.AssignedToGroup || ''
          ),
          // Nome do grupo especialista. So e exibido quando DIFERE do grupo
          // designado — ver o comentario do LAYOUT_BUSCA.
          grupoEsp: String(
            (rel.ExpertGroup && rel.ExpertGroup.Name)
            || (p.ExpertGroup && p.ExpertGroup.Name)
            || p['ExpertGroup.Name'] || ''
          ),
          criadoEm: Number(p.CreateTime) || 0,
          atualizadoEm: Number(p.LastUpdateTime) || 0,
          ehGlobal: ehVerdadeiro(p.IsGlobal_c),
          // Auto-referencia nao e vinculo de pai (mesma regra do `conferir`).
          paiId: pai && pai !== id ? pai : ''
        };
      }).filter(x => x.id);

      // Filho de outro global nao e candidato, e o filtro do servidor nao
      // conseguiu tirar. Sai aqui, e o quanto saiu e devolvido para a tela
      // poder explicar a diferenca entre o total e o que ela mostra.
      const semFilhos = itens.filter(x => !x.paiId);
      return {
        filtro,
        total: Number.isFinite(total) ? total : itens.length,
        itens: semFilhos,
        descartados: itens.length - semFilhos.length,
        // `lidos` conta as linhas que o SERVIDOR devolveu, nao as que sobraram:
        // e esse numero que faz o `skip` da proxima pagina cair no lugar certo.
        lidos: brutos.length,
        proximoSkip: skip + brutos.length
      };
    };

    return {
      conferir, emLote, extrairGlobalId, lerEstado, contarFilhos, sondarFilhos,
      motivoDeErro, lerChamado, parseComentarios,
      contarBusca, buscarPagina, PAGINA_BUSCA
    };
  })();

  /* =========================================================
   * PgMonitor — fase 6: o que mudou nos globais da minha lista
   *
   * Duas perguntas, e so duas (analise §22.5 item 5): mudou algo num global que
   * eu acompanho, e apareceram filhos novos. NAO e vigiar os chamados novos do
   * SMAX — isso seria outro produto, e muito mais caro.
   *
   * A peca que fazia falta nao era a leitura: ela ja existia inteira em
   * `atualizarDoSmax`. Era o DIFF. O `mesclarEstado` sobrescreve o registro, e
   * portanto destroi a evidencia da mudanca no exato instante em que ela existe.
   * Por isso o diff mora DENTRO do pipeline de leitura, antes do merge — com um
   * efeito colateral bom: o "Atualizar do SMAX" manual passa a produzir novidade
   * tambem, em vez de engoli-la.
   * =======================================================*/
  const PgMonitor = (() => {
    // Quem avisar quando a lista de novidades mudar. A HUD assina no `init` para
    // atualizar o selo do botao flutuante; sem assinante, o monitor roda igual.
    let ouvinte = null;
    let rodando = false;
    let timer = null;
    // Identidade desta aba. Serve para a reivindicacao da rodada (ver `tentar`):
    // a aba grava a agenda e releia para conferir que o dono e ela mesma.
    const MINHA_ABA = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const TIPOS = {
      filhos: { rot: 'Filhos', peso: 3 },
      status: { rot: 'Status', peso: 2 },
      grupo: { rot: 'Grupo', peso: 1 },
      atualizado: { rot: 'Atualizado', peso: 0 }
    };

    /* O diff de UM global.
     *
     * A regra que nao se negocia: comparacao so acontece quando existe valor
     * ANTERIOR. Campo que nunca foi lido vale `undefined`/`null` e significa "nao
     * sei", nunca zero — e neste codigo `filhos: null` ja carrega esse
     * significado (:426). Sem esse sentinela (a licao do
     * Monitor-de-solicitacoes.user.js:512-513), a primeira rodada anunciaria
     * "+2.614 filhos" em cada global da lista e o usuario desligaria o monitor
     * no primeiro dia.
     *
     * Um global pode gerar mais de um item na mesma rodada — filhos novos E
     * troca de status sao duas noticias diferentes. O item generico
     * ("atualizado") sai so quando nenhum dos especificos saiu: `LastUpdateTime`
     * cresce em toda gravacao, inclusive nas que ja foram descritas com precisao
     * pelos outros itens, e repetir a mesma gravacao em duas linhas seria ruido. */
    const diffGlobal = (id, antes, depois, quando) => {
      const itens = [];
      if (!antes) return itens; // primeira leitura deste global: nao e novidade
      const add = (tipo, texto) => itens.push({ id, titulo: depois.titulo || antes.titulo || '', tipo, texto, quando });

      const a = antes.filhosSonda;
      const d = depois.filhosSonda;
      if (typeof a === 'number' && typeof d === 'number' && a !== d) {
        const delta = d - a;
        // Queda de filho tambem e noticia, e nao se detecta de outra forma:
        // desvincular um filho mexe no LastUpdateTime do FILHO, nao no do pai.
        // Sem contar aqui, a queda passaria em silencio.
        add('filhos', delta > 0
          ? `${delta} filho(s) novo(s) — de ${a} para ${d}`
          : `${-delta} filho(s) a menos — de ${a} para ${d}`);
      }

      if (antes.status !== undefined && depois.status !== undefined
          && (antes.status !== depois.status || antes.statusOp !== depois.statusOp)) {
        const de = `${Metrica.rotuloStatus(antes.status) || antes.status || '—'} / ${Metrica.rotuloStatusOp(antes.statusOp) || '—'}`;
        const para = `${Metrica.rotuloStatus(depois.status) || depois.status || '—'} / ${Metrica.rotuloStatusOp(depois.statusOp) || '—'}`;
        // Encerrar e o caso que merece texto proprio: e o gatilho da sugestao de
        // arquivar, e o usuario precisa ligar uma coisa na outra.
        // `Metrica.encerrada` recebe a LINHA e nao o status (ver o comentario na
        // definicao: linha sem leitura tem de devolver `null`, nao `false`). Aqui
        // os dois lados foram lidos — o `if` acima ja garantiu que ha status nos
        // dois —, entao o `lido:true` e verdade, nao atalho.
        const fim = (st) => Metrica.encerrada({ lido: true, status: st });
        const virouEncerrado = !fim(antes.status) && fim(depois.status);
        add('status', `${de} → ${para}${virouEncerrado ? ' (encerrado — dá para arquivar)' : ''}`);
      }

      if (antes.grupo !== undefined && depois.grupo !== undefined && antes.grupo !== depois.grupo) {
        add('grupo', `${antes.grupo || '—'} → ${depois.grupo || '—'}`);
      }

      if (!itens.length
          && typeof antes.atualizadoEm === 'number' && typeof depois.atualizadoEm === 'number'
          && depois.atualizadoEm > antes.atualizadoEm) {
        // De proposito nao diz O QUE mudou: a leitura enxuta nao traz comentario
        // nem descricao, e inventar o motivo seria pior do que admitir a lacuna.
        add('atualizado', 'alguma alteração no chamado (comentário, atribuição ou campo) — a leitura enxuta não diz qual');
      }
      return itens;
    };

    /* O pipeline completo de leitura, usado pelo botao "Atualizar do SMAX" e pela
     * rodada automatica quando a sondagem acha movimento. Faz leitura, diff e
     * merge nessa ordem — a ordem importa, porque o merge apaga o "antes". */
    const lerTudo = async (ids, onProgresso) => {
      const prog = onProgresso || (() => {});
      prog('estado', 0, 0);
      const est = await PgApi.lerEstado(ids, (f, t) => prog('estado', f, t));
      prog('filhos', 0, 0);
      const fil = await PgApi.contarFilhos(ids, (f, t) => prog('filhos', f, t));
      const son = await PgApi.sondarFilhos(ids);

      // A contagem entra no mesmo registro do estado. Pai sem contagem nesta
      // passada fica SEM a chave `filhos` — a tela mostra "nao lido", nunca 0.
      Object.entries(est.porId).forEach(([id, e]) => {
        if (fil.porPai[id] !== undefined) e.filhos = fil.porPai[id];
        // A marca d'agua da sondagem anda junto, senao a proxima sondagem
        // compararia contra um valor velho e acharia movimento que nao houve.
        if (son.porPai[id] !== undefined) e.filhosSonda = son.porPai[id];
      });

      const novidades = diffDoLote(est.porId);
      PgStore.mesclarEstado(est.porId);
      if (novidades.length) {
        PgStore.registrarNovidades(novidades);
        if (ouvinte) ouvinte(novidades);
      }

      // Id que o bloco cobriu mas o SMAX nao devolveu: existe no painel e nao
      // volta na consulta. E leitura bem-sucedida com resposta vazia, o que
      // normalmente significa chamado apagado ou sem permissao.
      const cobertos = new Set(est.falhas.flatMap(x => x.ids));
      const ausentes = ids.filter(id => !cobertos.has(id) && !est.porId[id]);

      return { est, fil, son, novidades, ausentes };
    };

    /* O diff de um lote inteiro, contra o estado que esta em disco AGORA.
     * Arquivado fica de fora: a v1.12 o esconde da lista, e avisar sobre o que
     * nao esta na tela seria incoerente — o usuario nao teria onde olhar. */
    const diffDoLote = (porId) => {
      const estado = PgStore.estado().porId;
      const arquivados = new Set(
        PgStore.dados().globais.filter(g => g.arquivado).map(g => String(g.id))
      );
      const quando = Date.now();
      const itens = [];
      Object.entries(porId).forEach(([id, depois]) => {
        if (arquivados.has(id)) return;
        itens.push(...diffGlobal(id, estado[id], depois, quando));
      });
      // Mais relevante primeiro DENTRO da rodada: filho novo antes de "mudou
      // alguma coisa". Entre rodadas quem ordena e a hora (a lista e empilhada).
      itens.sort((x, y) => (TIPOS[y.tipo].peso - TIPOS[x.tipo].peso) || x.id.localeCompare(y.id));
      return itens;
    };

    /* ---------- A rodada automatica ---------- */

    const idsMonitorados = () => PgStore.dados().globais
      .filter(g => !g.arquivado)
      .map(g => String(g.id));

    /* A sondagem: barata, e so para decidir se vale a leitura cara.
     * Compara contra `filhosSonda` (mesma metrica, ver PgApi) e contra
     * `atualizadoEm`. Global que nunca foi lido ENTRA na leitura completa — nao
     * para gerar novidade (o sentinela impede), mas para a marca d'agua nascer. */
    const rodada = async () => {
      const ids = idsMonitorados();
      if (!ids.length) return { pulou: 'lista vazia' };
      const estado = PgStore.estado().porId;

      const est = await PgApi.lerEstado(ids);
      const son = await PgApi.sondarFilhos(ids);

      const mexeram = ids.filter((id) => {
        const antes = estado[id];
        if (!antes) return true;                    // nunca lido: precisa nascer
        const dep = est.porId[id];
        if (!dep) return false;                     // nao voltou: nada a comparar
        if (typeof antes.filhosSonda !== 'number') return true;
        if (son.porPai[id] !== undefined && son.porPai[id] !== antes.filhosSonda) return true;
        if (dep.status !== antes.status || dep.statusOp !== antes.statusOp) return true;
        if (dep.grupo !== antes.grupo) return true;
        return (Number(dep.atualizadoEm) || 0) > (Number(antes.atualizadoEm) || 0);
      });

      if (!mexeram.length) return { nada: true, sondados: ids.length };
      // Leitura completa SO nos que mexeram. E aqui que o custo aparece, e e por
      // isso que ele e pago so quando ha motivo.
      const r = await lerTudo(mexeram);
      return { sondados: ids.length, relidos: mexeram.length, novidades: r.novidades };
    };

    /* ---------- Agendamento ----------
     * O tique e de 60 s, mas quem decide se a rodada acontece e a agenda
     * compartilhada no storage do Tampermonkey (ver PgStore). Uma aba so roda se
     * reivindicar a vez e, ao reler, confirmar que o dono e ela — e um
     * compare-and-set pobre, e para este caso basta: o pior resultado de uma
     * colisao e uma leitura repetida, nao dado errado. */
    const TIQUE_MS = 60000;
    const intervaloMs = () => Math.max(1, Number(PgStore.prefs.monitor.minutos) || 30) * 60000;

    const tentar = async () => {
      if (rodando || !PgStore.prefs.monitor.ligado) return;
      const agora = Date.now();
      const ag = PgStore.lerAgenda();

      // Primeira vez (ou agenda apagada): nao roda agora, agenda. Rodar na hora
      // significaria uma leitura do acervo a cada vez que o usuario abre o SMAX,
      // que e muitas vezes por dia.
      if (!ag.proxima) {
        PgStore.salvarAgenda({ proxima: agora + intervaloMs(), dono: '', rodadaEm: 0 });
        return;
      }
      if (agora < ag.proxima) return;

      PgStore.salvarAgenda({ proxima: agora + intervaloMs(), dono: MINHA_ABA, rodadaEm: agora });
      // Releitura: se outra aba reivindicou no mesmo tique, ela e a dona e esta
      // aqui desiste.
      if (PgStore.lerAgenda().dono !== MINHA_ABA) return;

      rodando = true;
      try {
        const r = await rodada();
        if (r && r.novidades && r.novidades.length) {
          console.log(`[SMAX Painel] monitor: ${r.novidades.length} novidade(s) em ${r.relidos} global(is).`);
        }
      } catch (err) {
        // Falha de rede nao pode matar o monitor: a proxima rodada ja esta
        // agendada, e o painel continua dizendo a hora da ultima leitura boa.
        console.warn('[SMAX Painel] monitor: rodada falhou:', err);
      } finally {
        rodando = false;
      }
    };

    const iniciar = () => {
      if (timer) return;
      timer = setInterval(tentar, TIQUE_MS);
      // Um tique logo apos o carregamento, para o caso de a agenda ja estar
      // vencida (maquina que ficou desligada, aba reaberta de manha).
      setTimeout(tentar, 15000);
    };

    // Chamado quando o usuario muda a configuracao: ligar tem de valer na hora, e
    // mudar o intervalo tem de reagendar em vez de esperar o antigo vencer.
    const reagendar = () => {
      PgStore.salvarAgenda({ proxima: Date.now() + intervaloMs(), dono: '', rodadaEm: 0 });
    };

    return {
      iniciar, reagendar, lerTudo, rodada, diffGlobal, TIPOS,
      proxima: () => PgStore.lerAgenda().proxima,
      onNovidades: (fn) => { ouvinte = fn; }
    };
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
   * Grupos — busca de GSE para o filtro da aba Consultar.
   *
   * A entidade e `PersonGroup`, NAO `Group`: o codigo de producao de terceiro
   * registra que `Group` devolve "operação não permitida" e que o nome certo e
   * PersonGroup, confirmado ao vivo pelo autor
   * (_fontes-leonardo/.../pesquisa-avancada-smax.user.js:3560-3574).
   *
   * Aqui o operador de texto e `wordstartswith`, e nao o range de prefixo do
   * `People`: ele esta provado em PersonGroup (mesma referencia). Em `Request`
   * nunca foi visto funcionando — e por isso que procurar global por texto do
   * titulo continua sendo peneira no cliente, nunca filtro de servidor.
   * =======================================================*/
  const Grupos = (() => {
    const MIN_CHARS = 2;

    const search = async (term) => {
      const palavras = String(term || '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
      if (!palavras.length || String(term).trim().length < MIN_CHARS) return [];
      // Aspas simples dobradas: e o escape do dialeto, e o termo vem do teclado.
      const clausulas = palavras
        .map(p => `(Name wordstartswith ('${p.replace(/'/g, "''")}'))`)
        .join(' and ');
      // `Status = null` entra junto de proposito: grupo sem status gravado
      // existe, e filtrar so por 'Active' o esconderia sem dizer nada.
      const payload = await ApiClient.request('ems/PersonGroup', {
        method: 'GET',
        searchParams: {
          filter: `((Status = 'Active' or Status = null) and (${clausulas}))`,
          layout: 'Name',
          size: '30',
          skip: '0',
          order: 'Name asc'
        },
        includeTenantParam: true
      });
      const porId = new Map();
      ((payload && payload.entities) || []).forEach((e) => {
        const p = (e && e.properties) || {};
        const id = p.Id != null ? String(p.Id) : '';
        const nome = String(p.Name || '').trim();
        if (id && nome && !porId.has(id)) porId.set(id, { id, nome });
      });
      return [...porId.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    };

    return { MIN_CHARS, search };
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
/* Com o painel em tela cheia o botao ficaria boiando por cima do conteudo,
   sem nada atras para voltar — e o X do cabecalho ja fecha. */
#smax-global-btn[data-aberto="true"] { display:none; }
@keyframes smax-gl-pulse { 0%,100% { box-shadow:0 0 0 0 var(--sp-ring); } 50% { box-shadow:0 0 0 10px transparent; } }

/* Selo de novidade do monitor. Fica no botao flutuante porque e o unico pedaco
   do script que esta sempre na tela — o painel passa a maior parte do tempo
   fechado, e novidade que so aparece depois de abrir o painel nao avisa nada.
   Em elemento irmao e nao em ::after do proprio botao: a propriedade content nao
   se atualiza sem reescrever a regra de CSS, e o numero muda. */
#smax-global-selo {
  position:fixed; right:6px; bottom:88px; z-index:1000000;
  min-width:18px; height:18px; padding:0 5px; border-radius:9px;
  background:var(--sp-danger); color:#fff; font-size:10.5px; font-weight:700;
  font-family:Consolas, monospace; line-height:18px; text-align:center;
  box-shadow:var(--sp-shadow); cursor:pointer; border:none;
}
#smax-global-selo[data-n="0"] { display:none; }
/* Esconde junto com o botao: com o painel aberto a aba Novidades e que informa. */
#smax-global-selo[data-aberto="true"] { display:none; }

/* Aviso na tela. Dura 14 s e sai; o selo e que persiste. Dois canais de
   proposito: o aviso chama a atencao de quem esta olhando o SMAX agora, o selo
   atende quem voltou do cafe. */
#smax-global-aviso {
  position:fixed; right:12px; bottom:110px; z-index:1000000;
  width:min(320px, 80vw); padding:10px 12px;
  background:var(--sp-card-bg); color:var(--sp-text);
  border:1px solid var(--sp-accent); border-left-width:3px;
  border-radius:var(--sp-r-md); box-shadow:var(--sp-shadow);
  font-size:12px; line-height:1.5; cursor:pointer;
}
#smax-global-aviso b { display:block; font-size:12.5px; margin-bottom:3px; }
#smax-global-aviso ul { margin:4px 0 0; padding-left:16px; }
#smax-global-aviso li { margin:1px 0; }
#smax-global-aviso .smax-gl-aviso-mais { color:var(--sp-text-muted); font-size:11px; }

/* Novidades */
.smax-gl-nov { display:flex; flex-direction:column; gap:6px; }
.smax-gl-nov-item {
  display:grid; grid-template-columns:auto 1fr auto; align-items:start; gap:10px;
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md);
  background:var(--sp-card-bg); padding:8px 10px;
}
/* Barra na lateral marca o que ainda nao foi visto. Cor de fundo inteira seria
   forte demais numa lista que pode ter 200 linhas. */
.smax-gl-nov-item[data-novo="true"] { border-left:3px solid var(--sp-accent); }
.smax-gl-nov-tipo {
  font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; font-weight:600;
  border:1px solid currentColor; border-radius:9px; padding:1px 7px; white-space:nowrap;
}
.smax-gl-nov-tipo[data-tipo="filhos"] { color:var(--sp-danger-text); }
.smax-gl-nov-tipo[data-tipo="status"] { color:var(--sp-accent); }
.smax-gl-nov-tipo[data-tipo="grupo"] { color:var(--sp-pending); }
.smax-gl-nov-tipo[data-tipo="atualizado"] { color:var(--sp-text-muted); }
.smax-gl-nov-tit { font-size:12.5px; color:var(--sp-text); }
.smax-gl-nov-tit b { font-family:Consolas, monospace; }
.smax-gl-nov-txt { font-size:11.5px; color:var(--sp-text-muted); margin-top:2px; }
.smax-gl-nov-quando { font-size:10.5px; color:var(--sp-text-dim); white-space:nowrap; }

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
/* O painel vai em tela cheia: e ferramenta de trabalho, nao aviso. Os modais
   continuam caixa centrada — ali o recorte e justamente o que separa a
   pergunta do que esta por tras dela, e encher a tela so atrapalharia. */
.smax-gl-overlay:not(.smax-gl-modal) { padding:0; }
.smax-gl-overlay:not(.smax-gl-modal) > .smax-gl-panel {
  width:100vw; max-width:none; height:100vh; max-height:none;
  border:none; border-radius:0;
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

/* Rola nos dois eixos, e o eixo X e declarado de proposito: a tabela do painel
   pode ficar mais larga do que a tela quando o usuario alarga as colunas, e e
   este elemento que tem de rolar — ele e o mesmo que rola na vertical, o que
   mantem o cabecalho sticky funcionando. */
.smax-gl-body { padding:16px; overflow:auto; flex:1 1 auto; }
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
.smax-gl-badge-warn { color:var(--sp-pending); }
.smax-gl-badge-err { color:var(--sp-danger-text); }

/* TODAS as abas usam a largura toda da tela. Antes as de formulario eram
   centradas numa coluna de 920px por padding (data-wide="false"); o pedido
   foi tela cheia em todas, entao a unica largura e a da tela. */
.smax-gl-filtros { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; margin-bottom:12px; }
.smax-gl-filtros > div { min-width:0; }
/* table-layout:fixed e o que torna a largura de coluna obedecida: em layout
   automatico o navegador trata largura como sugestao e recalcula pelo conteudo,
   entao arrastar a divisa nao mudaria quase nada em coluna de texto longo.
   O preco e que agora e o <colgroup> que manda, e conteudo maior do que a
   celula precisa de tratamento explicito (as regras de td abaixo). */
.smax-gl-tbl { width:100%; border-collapse:collapse; font-size:11.5px; table-layout:fixed; }
.smax-gl-tbl th {
  text-align:left; padding:6px 8px; font-size:10px; text-transform:uppercase;
  letter-spacing:.4px; color:var(--sp-text-muted); border-bottom:1px solid var(--sp-border);
  white-space:nowrap; background:var(--sp-surface-2); position:sticky; top:0; z-index:1;
  /* position:sticky tambem serve de referencia para o absolute da alca —
     nao precisa (nem pode) virar relative, que tiraria o cabecalho fixo. */
  overflow:hidden;
}
.smax-gl-tbl th[data-ordem] { cursor:pointer; }
.smax-gl-tbl th[data-ordem]:hover { color:var(--sp-accent); }
.smax-gl-tbl th[data-ativa="true"] { color:var(--sp-accent); }
/* Coluna estreitada demais corta o proprio titulo; com reticencias da para ver
   que esta cortado, sem elas o texto simplesmente desaparece na divisa. */
.smax-gl-th-rot { display:inline-block; max-width:calc(100% - 22px); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; }
/* Na coluna inativa a seta e so a dica de que da para clicar: apagada, e so
   aparece de verdade no hover. Na ativa ela carrega informacao (a direcao). */
.smax-gl-tbl th[data-ativa="false"] .smax-gl-seta { opacity:.25; }
.smax-gl-tbl th[data-ordem]:hover .smax-gl-seta { opacity:1; }
/* 8px de area de pega para uma divisa de 1px: alvo de 1px nao se acerta com o
   mouse. Fica toda DENTRO da celula (right:0, sem valor negativo) porque o th
   tem overflow:hidden e cortaria qualquer avanco sobre a coluna vizinha. */
.smax-gl-grip {
  position:absolute; top:0; right:0; width:8px; height:100%;
  cursor:col-resize; z-index:2; background:transparent;
  /* user-select para que apertar a alca nunca comece a selecionar o texto do
     cabecalho; touch-action para o navegador nao confundir o arraste com rolagem
     e cancelar o ponteiro no meio. */
  user-select:none; touch-action:none;
}
.smax-gl-grip::after {
  content:''; position:absolute; top:3px; bottom:3px; right:0; width:1px;
  background:var(--sp-border); transition:background .12s;
}
.smax-gl-grip:hover::after { background:var(--sp-accent); width:2px; }
/* Enquanto arrasta, o cursor tem de continuar de redimensionar mesmo saindo do
   cabecalho, e a selecao de texto tem de ficar desligada — sem isso o arraste
   vira um "selecionar a tabela toda" azul. */
.smax-gl-root[data-redim="true"], .smax-gl-root[data-redim="true"] * {
  cursor:col-resize !important; user-select:none !important;
}
.smax-gl-root[data-redim="true"] .smax-gl-grip::after { background:var(--sp-accent); width:2px; }
.smax-gl-larg-aviso {
  display:flex; align-items:center; justify-content:flex-end; gap:8px;
  font-size:11px; color:var(--sp-text-muted); margin:0 0 6px;
}
.smax-gl-larg-aviso button { padding:2px 8px; font-size:10.5px; }
.smax-gl-larg-aviso[data-ajustada="false"] { display:none; }
/* Em layout fixo o conteudo nao empurra mais a coluna: ou quebra linha, ou
   vaza por cima da vizinha. Quebrar e o certo para texto; break-word cobre o
   titulo sem espaco, que nao tem onde quebrar naturalmente. */
.smax-gl-tbl td {
  padding:6px 8px; border-bottom:1px solid var(--sp-border); vertical-align:top;
  overflow-wrap:break-word; word-break:break-word;
}
.smax-gl-tbl tr[data-arquivado="true"] td { opacity:.5; }
.smax-gl-tbl tr:hover td { background:var(--sp-primary-bg); }
/* Estes nao quebram (numero e data quebrados nao se leem), entao cortam. */
.smax-gl-tbl .smax-gl-num {
  font-family:Consolas, monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.smax-gl-filhos { font-family:Consolas, monospace; font-weight:600; text-align:right; white-space:nowrap; }
/* "Nao lido" nunca pode ser lido como zero: cor e texto diferentes. */
.smax-gl-naolido { color:var(--sp-text-dim); font-style:italic; font-family:inherit; font-weight:400; }
.smax-gl-marcas { display:flex; flex-wrap:wrap; gap:3px; }
.smax-gl-marca {
  font-size:10px; padding:1px 6px; border-radius:9px;
  background:var(--sp-surface-2); border:1px solid var(--sp-border); color:var(--sp-text-muted);
  white-space:nowrap;
}
.smax-gl-acoes { white-space:nowrap; text-align:right; }
.smax-gl-acoes button { padding:3px 7px; font-size:10.5px; }
.smax-gl-resumo { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px; }
.smax-gl-card {
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md); padding:8px 12px;
  background:var(--sp-card-bg); min-width:92px;
}
.smax-gl-card b { display:block; font-size:18px; font-weight:600; color:var(--sp-text); line-height:1.2; }
.smax-gl-card span { font-size:10px; text-transform:uppercase; letter-spacing:.4px; color:var(--sp-text-muted); }

/* Visualizador de chamado. */
.smax-gl-ver-dados {
  display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:10px;
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md); padding:10px 12px;
  background:var(--sp-card-bg); font-size:12.5px;
}
/* Conteudo de terceiro: limitar a largura em TUDO e obrigatorio. Chamado com
   print colado de 2000px de largura esticava o modal e empurrava o resto da
   tela para fora — e a tabela precisa de table-layout fixo porque tabela colada
   do Excel ignora a largura do container sem isso. */
.smax-gl-rico {
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md); padding:10px 12px;
  background:var(--sp-surface); font-size:13px; line-height:1.55; color:var(--sp-text);
  overflow-x:auto; word-break:break-word;
}
.smax-gl-rico img { max-width:100%; height:auto; }
.smax-gl-rico table { max-width:100%; table-layout:fixed; border-collapse:collapse; }
.smax-gl-rico td, .smax-gl-rico th { border:1px solid var(--sp-border); padding:4px 6px; }
.smax-gl-rico a { color:var(--sp-accent); }
.smax-gl-coment { margin-top:8px; }
.smax-gl-coment .smax-gl-cand-meta { display:flex; align-items:center; gap:6px; margin-bottom:3px; }
/* Interno e o comentario que o solicitante nao ve. A borda a esquerda existe
   para dar para diferenciar correndo o olho pela lista, sem ler o selo. */
.smax-gl-coment-int .smax-gl-rico { border-left:3px solid var(--sp-pending); }

/* Graficos. HTML e CSS, sem biblioteca e sem SVG: barra e uma div com width em
   porcentagem, e assim o texto do rotulo tem tamanho real — com viewBox de SVG
   ele encolheria junto com o desenho e ficaria ilegivel no cartao estreito. */
.smax-gl-grafs { display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:12px; }
.smax-gl-graf {
  border:1px solid var(--sp-border); border-radius:var(--sp-r-md);
  background:var(--sp-card-bg); padding:10px 12px; min-width:0;
}
.smax-gl-graf-h { display:flex; align-items:baseline; gap:8px; margin-bottom:8px; }
.smax-gl-graf-h b { font-size:12.5px; font-weight:600; color:var(--sp-text); flex:1 1 auto; }
/* A base de contagem fica no cabecalho de todo grafico, sem excecao: dois
   graficos na mesma tela com bases diferentes e sem rotulo se contradizem
   sem ninguem notar. */
.smax-gl-graf-base {
  font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; white-space:nowrap;
  color:var(--sp-text-muted); border:1px solid var(--sp-border);
  border-radius:9px; padding:1px 7px; background:var(--sp-surface-2);
}
/* A serie por mes cresce para o lado; dividir a largura com outro cartao
   deixaria as colunas com 6px. */
.smax-gl-graf-wide { grid-column:1 / -1; }
.smax-gl-graf-nota { font-size:11px; line-height:1.5; color:var(--sp-text-muted); margin:8px 0 0; }
.smax-gl-graf-nota strong { color:var(--sp-text); }
.smax-gl-bars { display:flex; flex-direction:column; gap:3px; }
.smax-gl-bar {
  display:grid; grid-template-columns:minmax(0, 38%) 1fr auto;
  align-items:center; gap:8px; padding:2px 4px; border-radius:var(--sp-r-sm);
}
.smax-gl-bar[data-act] { cursor:pointer; }
.smax-gl-bar[data-act]:hover { background:var(--sp-primary-bg); }
.smax-gl-bar[data-act]:hover .smax-gl-bar-rot { color:var(--sp-accent); }
.smax-gl-bar[data-ativa="true"] { background:var(--sp-primary-bg); }
.smax-gl-bar[data-ativa="true"] .smax-gl-bar-rot { color:var(--sp-accent); font-weight:600; }
.smax-gl-bar-rot {
  font-size:11px; color:var(--sp-text-muted); text-align:right;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.smax-gl-bar-trilho { display:block; height:13px; border-radius:3px; background:var(--sp-surface-2); }
.smax-gl-bar-fill { display:block; height:100%; border-radius:3px; background:var(--sp-accent); }
/* Zero nao e barra de largura 0 — seria indistinguivel de "nao desenhou". */
.smax-gl-bar-fill[data-zero="true"] { background:var(--sp-border); }
.smax-gl-bar-val { font-size:11px; font-weight:600; color:var(--sp-text); font-family:Consolas, monospace; }

.smax-gl-cols { display:flex; align-items:flex-end; gap:5px; overflow-x:auto; padding-bottom:2px; }
.smax-gl-col { flex:1 1 0; min-width:28px; display:flex; flex-direction:column; align-items:center; }
.smax-gl-col-val { font-size:10px; font-weight:600; color:var(--sp-text); height:13px; }
.smax-gl-col-fill {
  display:block; width:100%; max-width:30px; border-radius:3px 3px 0 0;
  background:var(--sp-accent);
}
.smax-gl-col-fill[data-zero="true"] { background:var(--sp-border); }
.smax-gl-col-rot { font-size:10px; color:var(--sp-text-muted); margin-top:4px; white-space:nowrap; }

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
/* Marcacao em lote: a caixa de GSE aceita varias por busca, entao precisa de
   uma linha de acao coletiva e de um indicador de marcado por linha. */
.smax-gl-person-bulk {
  display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap;
  font-size:11.5px; color:var(--sp-text-muted);
}
.smax-gl-person-bulk > span { flex:1 1 auto; min-width:0; }
.smax-gl-person-tick { flex:0 0 auto; font-size:13px; color:var(--sp-accent); }
`);

  /* =========================================================
   * Graficos — HTML e CSS, sem biblioteca.
   *
   * Duas decisoes aqui, e as duas tem motivo:
   *
   * 1. Sem biblioteca de CDN. Os graficos deste painel sao barras, e barra e
   *    um retangulo com um texto do lado. Carregar uma biblioteca traria um
   *    site de terceiro para dentro da pagina do SMAX em troca de muito pouco
   *    — e e justamente o padrao (`@require` de Dexie, mammoth, pdf.js) que os
   *    quatro scripts de terceiro analisados adotam e que aqui nao se paga.
   *
   * 2. Sem SVG. A primeira versao desenhava em SVG com `viewBox`, e o
   *    `viewBox` escala TUDO junto, texto inclusive: num cartao de 340px o
   *    rotulo de 10,5px virava ~6px, ilegivel. Em HTML a barra e uma div com
   *    `width` em porcentagem e o texto e texto, no tamanho que foi pedido.
   *
   * Nenhuma funcao daqui decide O QUE contar: recebe os numeros ja agregados
   * por `Metrica.graficos` e so desenha. As regras de contagem ficam num
   * lugar so, que e o Metrica.
   * =======================================================*/
  const Graficos = (() => {
    const ALT_COLUNA = 104;   // px uteis de altura na serie por mes

    const nada = (msg) => `<div class="smax-gl-note">${Utils.escapeHtml(msg)}</div>`;

    /* Barras horizontais. Horizontal e nao vertical porque o rotulo e nome
     * livre digitado pelo usuario ("Execucao fiscal") — na vertical viraria
     * texto girado ou cortado. */
    const barrasH = (itens, opts = {}) => {
      if (!itens.length) return nada(opts.vazio || 'Nada para mostrar com os filtros atuais.');
      const max = Math.max(...itens.map(i => i.valor), 1);
      const linhas = itens.map((it) => {
        const atribs = [
          `data-id="${Utils.escapeHtml(it.id)}"`,
          `data-ativa="${(opts.ativos || []).includes(it.id)}"`,
          opts.acao ? `data-act="${Utils.escapeHtml(opts.acao)}"` : '',
          opts.eixo ? `data-eixo="${Utils.escapeHtml(opts.eixo)}"` : ''
        ].filter(Boolean).join(' ');
        // Valor zero vira um tracinho cinza. Barra de largura 0 e
        // indistinguivel de "nao desenhou nada".
        const zero = !it.valor;
        const larg = zero ? '3px' : `${Math.max(2, (it.valor / max) * 100)}%`;
        const dica = `${it.nome}${it.titulo ? ` — ${it.titulo}` : ''}: ${it.valor}`;
        return `<div class="smax-gl-bar" ${atribs} title="${Utils.escapeHtml(dica)}">
          <span class="smax-gl-bar-rot">${Utils.escapeHtml(it.nome)}</span>
          <span class="smax-gl-bar-trilho">
            <span class="smax-gl-bar-fill" data-zero="${zero}" style="width:${larg};"></span>
          </span>
          <span class="smax-gl-bar-val">${it.valor}</span>
        </div>`;
      }).join('');
      return `<div class="smax-gl-bars">${linhas}</div>`;
    };

    /* Barras verticais, so na serie por mes — ali a ordem das barras e o
     * tempo, e tempo se le da esquerda para a direita. */
    const barrasV = (itens, opts = {}) => {
      if (!itens.length) return nada(opts.vazio || 'Nada para mostrar com os filtros atuais.');
      const max = Math.max(...itens.map(i => i.valor), 1);
      const cols = itens.map((it) => {
        const alt = it.valor ? Math.max(3, Math.round((it.valor / max) * ALT_COLUNA)) : 3;
        return `<div class="smax-gl-col" title="${Utils.escapeHtml(`${it.nome}: ${it.valor}`)}">
          <span class="smax-gl-col-val">${it.valor || ''}</span>
          <span class="smax-gl-col-fill" data-zero="${!it.valor}" style="height:${alt}px;"></span>
          <span class="smax-gl-col-rot">${Utils.escapeHtml(it.nome)}</span>
        </div>`;
      }).join('');
      return `<div class="smax-gl-cols" style="--smax-gl-alt:${ALT_COLUNA}px;">${cols}</div>`;
    };

    const cartao = (titulo, base, grafico, nota) => `<section class="smax-gl-graf">
      <div class="smax-gl-graf-h">
        <b>${Utils.escapeHtml(titulo)}</b>
        <span class="smax-gl-graf-base">${Utils.escapeHtml(base)}</span>
      </div>
      ${grafico}
      ${nota ? `<p class="smax-gl-graf-nota">${nota}</p>` : ''}
    </section>`;

    return { barrasH, barrasV, cartao };
  })();

  /* =========================================================
   * HUD
   * =======================================================*/
  const GlobalHUD = (() => {
    let overlay = null;
    let launcher = null;
    let selo = null;
    let activeTab = 'painel';
    let unsubscribe = null;
    let busy = false;
    // Criar ou remover um valor redesenha a tela inteira; a URL digitada e ainda
    // nao salva nao pode morrer nesse redesenho. O token, de proposito, nao
    // sobrevive: campo de senha nunca e repreenchido.
    let urlDigitada = null;
    // Aba em que a PROXIMA abertura deve cair. Existe para o aviso e a
    // notificacao do monitor abrirem o painel direto nas novidades; fora disso
    // toda abertura cai no painel, como ficou definido no pivo.
    let abaInicial = null;

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
      contornoPurpose: prefs.contornoPurpose || 'SolucaoContorno_c',
      // Classificacao do global que esta sendo aberto. Fica aqui, e nao numa
      // pergunta depois de criar, porque e agora — escrevendo titulo e descricao —
      // que a pessoa sabe do que o chamado trata.
      marcas: { assunto: new Set(), base: new Set(), competencia: new Set() },
      incluirNoPainel: true
    };

    const personUI = { open: false, term: '', loading: false, error: '', results: [], searchSeq: 0 };
    let personDebounce = null;
    let filtroDebounce = null;

    // Estado da tela "Incluir global". De proposito nao persiste: a conferencia e
    // pontual, e resultado guardado estaria velho na proxima abertura do painel.
    const incluirUI = {
      texto: '', verificando: false, resultados: [], nota: '',
      marcas: { assunto: new Set(), base: new Set(), competencia: new Set() }
    };

    // Estado da tela "Consultar". Tambem nao persiste, pelo mesmo motivo: um
    // resultado de busca guardado estaria velho na proxima abertura.
    // `buscou` existe separado de `itens.length` porque "ainda nao procurei" e
    // "procurei e nao achou nada" sao duas telas diferentes, e confundi-las e
    // justamente a falha de mostrar ausencia de leitura como zero.
    const consultaUI = {
      dias: 90,            // 0 = sem recorte de data
      situacao: 'abertos', // abertos | encerrados | todos
      buscando: false,
      buscou: false,
      total: 0,            // quantos o SMAX diz que existem
      itens: [],
      descartados: 0,      // filhos de outro global, tirados no cliente
      lidos: 0,            // linhas que o servidor devolveu, somadas as paginas
      proximoSkip: 0,
      filtro: '',          // o filtro exato que foi enviado — aparece no erro
      erro: '',
      // Ids das GSEs da consulta EM CURSO, congelados na primeira pagina. As
      // escolhidas moram em PgStore.prefs e podem mudar no meio da paginacao.
      grupos: [],
      marcados: new Set(),
      // Classificacao e nota da leva que esta sendo marcada. Ficam aqui, na
      // propria aba, porque a decisao de assunto/base/competencia e tomada
      // LENDO o chamado — e e so aqui que da para ler.
      marcas: { assunto: new Set(), base: new Set(), competencia: new Set() },
      nota: '',
      incluindo: false,
      // Desfecho por id da ultima tentativa de inclusao: recusado nao pode
      // simplesmente nao entrar, tem de aparecer com o motivo.
      resultados: []
    };

    // Estado da caixa de GSE. A lista escolhida mora em PgStore.prefs (persiste);
    // isto aqui e so a busca, que e pontual.
    const gseUI = { open: false, term: '', loading: false, error: '', results: [], searchSeq: 0 };
    let gseDebounce = null;

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
      launcher.dataset.aberto = overlay ? 'true' : 'false';
      launcher.dataset.armed = Capture.isArmed() ? 'true' : 'false';
      launcher.title = Capture.isArmed()
        ? `SMAX Global — MODO APRENDER ativo${Capture.isDryRun() ? ' (seco: o SMAX vai acusar erro ao salvar, e nada é criado)' : ' (SEM modo seco: o chamado será criado de verdade)'}`
        : 'SMAX Global — abrir chamado global';
      if (selo) {
        const n = PgStore.naoVistas();
        selo.dataset.n = String(n);
        selo.dataset.aberto = overlay ? 'true' : 'false';
        // 99+ e para o selo nao virar uma faixa: ele mora num botao de 40px.
        selo.textContent = n > 99 ? '99+' : String(n);
        selo.title = `${n} novidade(s) não vista(s) nos globais do painel — clique para abrir.`;
      }
    };

    /* ---------- Os dois canais de aviso ----------
     * Divisao de trabalho: o AVISO chama a atencao de quem esta olhando o SMAX
     * agora e sai sozinho; o SELO fica e atende quem voltou depois. A
     * notificacao do SISTEMA e o terceiro canal, opcional, para quem esta com a
     * aba do SMAX em segundo plano — que e o caso de uso real do monitor. */
    let avisoTimer = null;

    const mostrarAviso = (itens) => {
      if (!itens || !itens.length) return;
      let box = document.getElementById('smax-global-aviso');
      if (!box) {
        box = document.createElement('div');
        box.id = 'smax-global-aviso';
        box.className = 'smax-gl-root';
        box.addEventListener('click', () => {
          box.remove();
          abrirEm('novidades');
        });
        document.body.appendChild(box);
      }
      const tres = itens.slice(0, 3);
      box.innerHTML = `
        <b>🌐 ${itens.length} novidade(s) nos globais</b>
        <ul>${tres.map(x => `<li>#${Utils.escapeHtml(x.id)} — ${Utils.escapeHtml(x.texto)}</li>`).join('')}</ul>
        ${itens.length > tres.length
          ? `<div class="smax-gl-aviso-mais">e mais ${itens.length - tres.length}… clique para ver a lista</div>`
          : '<div class="smax-gl-aviso-mais">clique para ver a lista</div>'}`;
      clearTimeout(avisoTimer);
      // 14 s: tempo de ler tres linhas sem o aviso virar parte da tela do SMAX.
      // Quem nao viu em 14 s ainda tem o selo, que nao expira.
      avisoTimer = setTimeout(() => box.remove(), 14000);
    };

    const notificarSO = (titulo, texto) => {
      if (!temNotificacao()) return;
      try {
        GM_notification({
          title: titulo,
          text: texto,
          timeout: 15000,
          // Clicar na notificacao traz a aba do SMAX para a frente e abre a aba
          // Novidades — sem isso o aviso informa e deixa o usuario procurando.
          onclick: () => {
            try { window.focus(); } catch { /* o navegador pode recusar o foco */ }
            abrirEm('novidades');
          }
        });
      } catch (err) {
        console.warn('[SMAX Painel] GM_notification falhou:', err);
      }
    };

    // Chamado pelo PgMonitor ao fim de uma rodada que achou algo.
    const aoNovidades = (itens) => {
      syncLauncher();
      mostrarAviso(itens);
      if (PgStore.prefs.monitor.notificarSO) {
        const porId = new Set(itens.map(x => x.id));
        notificarSO(
          `SMAX: ${itens.length} novidade(s) em ${porId.size} global(is)`,
          itens.slice(0, 3).map(x => `#${x.id} — ${x.texto}`).join('\n')
        );
      }
      // Painel aberto na aba de novidades: redesenha para a lista nao ficar velha
      // na frente do usuario.
      if (overlay && activeTab === 'novidades') render();
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
        </div>

        <div class="smax-gl-field">
          <label class="smax-gl-label">Classificação no painel</label>
          <div class="smax-gl-note">
            Marque agora, enquanto o assunto está fresco. Se errar, dá para
            reclassificar depois pelo <strong>Editar</strong> da linha no painel.
          </div>
          ${chipsEixos(form.marcas, 'abrir')}
          <div class="smax-gl-chips" style="margin-top:12px;">
            <button class="smax-gl-chip" data-act="toggle-incluir-painel"
                    data-active="${form.incluirNoPainel}">
              ${form.incluirNoPainel ? 'será incluído no painel' : 'não incluir no painel'}
            </button>
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

    /* ---------- Tela: painel ----------
     * `ordem` e a chave em `Metrica.CHAVES`; coluna sem `ordem` nao e clicavel.
     * `larg` e a largura padrao em px, e `chave` identifica a coluna na largura
     * gravada — tem de ser nome proprio, e nao a posicao, senao acrescentar
     * coluna no meio faria toda largura ja ajustada migrar para a coluna errada.
     *
     * UMA coluna e `elastica`: nao tem largura declarada, e em table-layout fixo
     * e ela que fica com o que sobrar da tabela. E o Titulo, e nao a de acoes
     * como na primeira tentativa (v1.13): a de acoes precisa de 238px para os
     * quatro botoes e nao se beneficia de um pixel a mais, entao absorvendo a
     * sobra ela ficava com 689px de vazio numa tela de 1725 — 40% da tabela
     * desperdicada — enquanto o titulo, que e texto longo, ficava apertado em
     * 240. Com o titulo elastico, estreitar qualquer coluna devolve o espaco a
     * ele, que e o que "ajustar a tela" quer dizer nesta tabela.
     *
     * `alca: false` tira o arraste da coluna. A de acoes nao se arrasta porque
     * esta na medida dos botoes, e a elastica nao se arrasta porque largura
     * declarada e justamente o que ela nao tem. */
    const COLUNAS = [
      { chave: 'numero', rot: 'Nº', ordem: 'numero', larg: 92 },
      { chave: 'titulo', rot: 'Título', ordem: 'titulo', elastica: true, min: 180 },
      { chave: 'status', rot: 'Status', ordem: 'status', larg: 100 },
      { chave: 'statusOp', rot: 'Operacional', ordem: 'statusOp', larg: 140 },
      { chave: 'grupo', rot: 'Grupo', ordem: 'grupo', larg: 130 },
      { chave: 'filhos', rot: 'Filhos', ordem: 'filhos', larg: 64 },
      { chave: 'marcacoes', rot: 'Marcações', ordem: 'marcacoes', larg: 150 },
      { chave: 'abertura', rot: 'Abertura', ordem: 'abertura', larg: 88 },
      // 238px e o que os quatro botoes medem na tela, mais o padding da celula.
      { chave: 'acoes', rot: '', larg: 244, alca: false }
    ];

    const LARG_MIN = 56;

    const temAlca = (c) => !c.elastica && c.alca !== false;
    const largDe = (c) => (PgStore.prefs.larguras[c.chave] || c.larg || 0);
    /* Alguma largura foi mexida? Decide se o aviso de restaurar aparece. Conta
     * so coluna que tem alca hoje: largura gravada por uma versao anterior para
     * coluna que virou elastica (foi o caso do titulo, ajustavel na v1.13) nao
     * muda nada na tela, e ofereceria restaurar um ajuste que nao se ve. */
    const largAjustada = () => COLUNAS.some(c => temAlca(c) && PgStore.prefs.larguras[c.chave] > 0);

    /* A tabela e `width:100%`, mas com este `min-width`. Os dois juntos dao o
     * comportamento esperado nas duas pontas: quando a soma das colunas cabe na
     * tela, a tabela ocupa tudo e a sobra vai para a coluna elastica; quando nao
     * cabe, o `min-width` segura o tamanho pedido e o corpo do painel rola na
     * horizontal. Sem o `min-width`, encolher a janela espremeria as colunas de
     * volta e o arraste do usuario nao sobreviveria a um simples redimensionar.
     *
     * A elastica entra pelo seu `min`, e nao por zero: em layout fixo coluna sem
     * largura declarada pode ser espremida a nada, e o titulo sumiria antes de a
     * barra de rolagem aparecer.
     *
     * `over` sobrepoe a largura de uma coluna sem gravar nada: e o que o arraste
     * usa para recalcular o total a cada movimento do mouse, antes de haver
     * largura gravada. */
    const somaLarguras = (over) => COLUNAS.reduce((s, c) => {
      if (c.elastica) return s + (c.min || 0);
      return s + ((over && over[c.chave]) || largDe(c));
    }, 0);

    const rotulosDe = (linha) => Dados.EIXOS.flatMap(e =>
      linha.marcas[e.chave].map(id => Dados.nomeDe(e.chave, id)).filter(Boolean)
    );

    // O painel vazio tem a mesma resposta nas duas telas que leem a lista.
    const vazio = () => (PgStore.dados().globais.length ? '' : `<div class="smax-gl-note">
      O painel está vazio. Use <strong>Consultar</strong> para achar os globais que já estão abertos
      no SMAX, ou <strong>Incluir global</strong> se você já tem os números em mãos. Em
      <strong>Configuração</strong> ficam os valores de assunto, base e competência.
    </div>`);

    // Um bloco de filtros só, usado pelo Painel e pelos Gráficos: dois
    // conjuntos de controle sobre a mesma lista daria duas respostas
    // diferentes para a mesma pergunta.
    // `arquivadosFixos` e para a tela de graficos, onde o arquivado entra na
    // conta sempre: um chip que nao muda nada e pior do que chip nenhum, porque
    // o usuario clica, nada acontece e ele conclui que a tela esta quebrada.
    const blocoFiltros = ({ arquivadosFixos = false } = {}) => {
      const f = PgStore.prefs.filtros;
      const chips = Dados.EIXOS.map(e => {
        const vals = Dados.lista(e.chave);
        if (!vals.length) return '';
        return `<div>
          <div class="smax-gl-label">${e.rotulo}</div>
          <div class="smax-gl-chips">
            ${vals.map(v => `<button class="smax-gl-chip" data-act="filtro-eixo"
                data-eixo="${e.chave}" data-id="${Utils.escapeHtml(v.id)}"
                data-active="${(f[e.chave] || []).includes(v.id)}">${Utils.escapeHtml(v.nome)}</button>`).join('')}
          </div>
        </div>`;
      }).join('');

      const statuses = Metrica.statusConhecidos();

      return `<div class="smax-gl-filtros">
        ${chips}
        <div>
          <div class="smax-gl-label">Status</div>
          <select class="smax-gl-select" id="smax-gl-f-status" style="min-width:150px;">
            <option value="">todos</option>
            ${statuses.map(s => `<option value="${Utils.escapeHtml(s)}" ${f.status === s ? 'selected' : ''}>${Utils.escapeHtml(Metrica.rotuloStatus(s))}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="smax-gl-label">Buscar</div>
          <input class="smax-gl-input" id="smax-gl-f-termo" type="text" style="min-width:180px;"
                 value="${Utils.escapeHtml(f.termo || '')}" placeholder="número, título, nota, grupo">
        </div>
        <div>
          <div class="smax-gl-label">Arquivados</div>
          ${arquivadosFixos
            ? `<span class="smax-gl-badge" title="Arquivar tira da lista de trabalho, não do histórico — nos gráficos o arquivado continua contando.">sempre contados</span>`
            : `<button class="smax-gl-chip" data-act="filtro-arquivados" data-active="${!!f.verArquivados}">
                 ${f.verArquivados ? 'mostrando' : 'ocultos'}
               </button>`}
        </div>
        <div><button class="smax-gl-btn" data-act="limpar-filtros">Limpar filtros</button></div>
      </div>`;
    };

    /* Os encerrados que estao NA TELA agora, sem os que ja foram arquivados.
     * A sugestao e a acao chamam esta mesma funcao de proposito: se cada uma
     * montasse a sua lista, o aviso poderia dizer "3" e o botao arquivar 4. */
    const encerradosNaTela = () => Metrica
      .listar(PgStore.prefs.filtros, PgStore.prefs.ordem, PgStore.prefs.ordemAsc)
      // `encerrada` devolve `null` para quem nao foi lido, e `=== true` deixa
      // esses de fora de proposito: nao se arquiva por falta de informacao.
      .filter(l => !l.arquivado && Metrica.encerrada(l) === true);

    const renderPainel = () => {
      const f = PgStore.prefs.filtros;
      const linhas = Metrica.listar(f, PgStore.prefs.ordem, PgStore.prefs.ordemAsc);
      const r = Metrica.resumo(linhas);
      const lidoEm = PgStore.estado().lidoEm;

      if (vazio()) return vazio();

      /* Sugestao de arquivamento. Encerrado que continua na lista de trabalho e
       * ruido, mas arquivar e decisao de quem cuida do painel: o script nao sabe
       * se o chamado foi encerrado de verdade ou fechado por engano / decurso de
       * prazo e ainda vai voltar. Por isso sugere e espera o clique — nunca
       * arquiva sozinho. O escopo e o que esta na tela: botao que mexesse em
       * linha escondida por filtro arquivaria o que o usuario nem viu. */
      const aArquivar = encerradosNaTela();
      const sugestao = aArquivar.length ? `
        <div class="smax-gl-note smax-gl-note-warn">
          <strong>${aArquivar.length}</strong> ${aArquivar.length === 1 ? 'global nesta tela já está encerrado' : 'globais nesta tela já estão encerrados'}
          (concluído, rejeitado ou cancelado). Arquivar tira ${aArquivar.length === 1 ? 'ele' : 'eles'} da
          lista sem perder nada: as marcações, a nota e a contagem de filhos ficam, e
          <strong>os gráficos continuam contando</strong>.
          <div style="margin-top:8px;">
            <button class="smax-gl-btn" data-act="arquivar-encerrados"
              >Arquivar ${aArquivar.length === 1 ? 'o encerrado' : `os ${aArquivar.length} encerrados`}</button>
          </div>
        </div>` : '';

      const corpo = linhas.length ? linhas.map(l => {
        const marcas = rotulosDe(l);
        // Celulas que NAO podem mostrar vazio como se fosse fato conhecido.
        const semLeitura = '<span class="smax-gl-naolido">não lido</span>';
        // Antes havia uma coluna "Lido" com o horario em toda linha — mesma data
        // repetida em todas, porque a leitura e de todos de uma vez e o rodape
        // ja diz quando foi. O horario por linha so informa quando DIVERGE do
        // da rodada: ai esta linha ficou para tras e isso vira um aviso.
        const atrasado = l.lido && lidoEm && l.lidoEm < lidoEm;
        return `<tr data-arquivado="${l.arquivado}">
          <td class="smax-gl-num">
            <a href="/saw/Request/${Utils.escapeHtml(l.id)}/general" target="_blank"
               style="color:var(--sp-accent);text-decoration:none;">#${Utils.escapeHtml(l.id)}</a>
            ${l.lido && l.ehGlobal === false
              ? '<br><span class="smax-gl-badge smax-gl-badge-err">não é global</span>' : ''}
            ${atrasado
              ? `<br><span class="smax-gl-badge smax-gl-badge-warn"
                     title="A última rodada não conseguiu reler este. O que está na linha é a leitura de ${Utils.escapeHtml(Utils.formatBrDateTime(l.lidoEm))}."
                  >não relido</span>` : ''}
            ${l.arquivado ? '<br><span class="smax-gl-badge">arquivado</span>' : ''}
          </td>
          <td>${l.lido ? Utils.escapeHtml(l.titulo || '(sem título)') : semLeitura}
            ${l.nota ? `<div class="smax-gl-cand-meta">${Utils.escapeHtml(l.nota)}</div>` : ''}</td>
          <td>${l.lido ? Utils.escapeHtml(Metrica.rotuloStatus(l.status) || '—') : semLeitura}</td>
          <td>${l.lido ? Utils.escapeHtml(Metrica.rotuloStatusOp(l.statusOp) || '—') : semLeitura}</td>
          <td>${l.lido ? Utils.escapeHtml(l.grupo || '—') : semLeitura}</td>
          <td class="smax-gl-filhos">${l.filhos === null ? semLeitura : l.filhos}</td>
          <td><div class="smax-gl-marcas">${marcas.length
            ? marcas.map(n => `<span class="smax-gl-marca">${Utils.escapeHtml(n)}</span>`).join('')
            : '<span class="smax-gl-naolido">sem marcação</span>'}</div></td>
          <td class="smax-gl-num" title="Incluído no painel em ${Utils.escapeHtml(l.incluidoEm || '—')}"
            >${l.criadoEm ? Utils.escapeHtml(Utils.formatBrDate(l.criadoEm)) : semLeitura}</td>
          <td class="smax-gl-acoes">
            <button class="smax-gl-btn" data-act="ver-global"
                    data-id="${Utils.escapeHtml(l.id)}">Ver</button>
            <button class="smax-gl-btn" data-act="editar-global"
                    data-id="${Utils.escapeHtml(l.id)}">Editar</button>
            <button class="smax-gl-btn" data-act="${l.arquivado ? 'desarquivar' : 'arquivar'}"
                    data-id="${Utils.escapeHtml(l.id)}">${l.arquivado ? 'Reabrir' : 'Arquivar'}</button>
            <button class="smax-gl-btn smax-gl-btn-danger" data-act="remover-global"
                    data-id="${Utils.escapeHtml(l.id)}">Remover</button>
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="${COLUNAS.length}">
          <div class="smax-gl-note">Nenhum global atende aos filtros.</div></td></tr>`;

      return `
        <div class="smax-gl-resumo">
          <div class="smax-gl-card"><b>${r.total}</b><span>na tela</span></div>
          <div class="smax-gl-card"><b>${r.filhos}</b><span>filhos somados</span></div>
          <div class="smax-gl-card"><b>${r.arquivados}</b><span>arquivados</span></div>
          ${r.naoLidos ? `<div class="smax-gl-card"><b style="color:var(--sp-danger-text);">${r.naoLidos}</b><span>sem leitura</span></div>` : ''}
        </div>

        ${lidoEm
          ? `<div class="smax-gl-note ${r.naoLidos || r.semContagem ? 'smax-gl-note-warn' : ''}">
               Estado lido do SMAX em <strong>${Utils.escapeHtml(Utils.formatBrDateTime(lidoEm))}</strong>.
               ${r.semContagem
                 ? `<strong>${r.semContagem}</strong> global(is) sem contagem de filhos — a soma acima é só do que foi lido.`
                 : ''}
               ${r.deixaramDeSerGlobal
                 ? ` <strong>${r.deixaramDeSerGlobal}</strong> já não está marcado como “É global” no SMAX.`
                 : ''}
             </div>`
          : `<div class="smax-gl-note smax-gl-note-warn">
               Nada foi lido do SMAX ainda. Clique em <strong>Atualizar do SMAX</strong>: até então,
               status, grupo e contagem de filhos aparecem como <em>não lido</em> — e não como zero.
             </div>`}

        ${sugestao}

        ${blocoFiltros()}

        <!-- Vai pro DOM sempre, escondido por CSS quando nao ha ajuste, em vez
             de so existir quando ha: o arraste termina sem re-render (de
             proposito, para nao perder a posicao da rolagem numa lista longa),
             entao ele precisa de um elemento ja pronto para revelar. Sem isso,
             quem arrastasse uma coluna para 56px ficaria sem a saida visivel ate
             o proximo clique em qualquer outra coisa. -->
        <div class="smax-gl-larg-aviso" data-ajustada="${largAjustada()}">
          Larguras ajustadas por você.
          <button class="smax-gl-btn" data-act="larguras-padrao">Restaurar padrão</button>
        </div>

        <table class="smax-gl-tbl" style="min-width:${somaLarguras()}px;">
          <colgroup>${COLUNAS.map(c => (c.elastica
            // Sem largura declarada: em table-layout fixo e esta coluna que fica
            // com o que sobrar da tabela.
            ? `<col data-col="${c.chave}">`
            : `<col data-col="${c.chave}" style="width:${largDe(c)}px;">`)).join('')}</colgroup>
          <thead><tr>${COLUNAS.map(c => {
            const alca = temAlca(c)
              ? `<span class="smax-gl-grip" data-grip="${c.chave}"
                       title="Arraste para mudar a largura desta coluna. Clique duplo volta ao padrão."></span>`
              : '';
            if (!c.ordem) return `<th>${c.rot}${alca}</th>`;
            const ativa = PgStore.prefs.ordem === c.ordem;
            // A seta da coluna ativa diz a direcao real; nas outras um ↕ apagado
            // diz apenas que da para clicar.
            const seta = ativa ? (PgStore.prefs.ordemAsc ? '▴' : '▾') : '↕';
            // A elastica nao tem alca, e isso precisa de explicacao no lugar em
            // que o usuario vai procurar por ela.
            const dica = c.elastica
              ? ' — esta coluna ocupa o espaço que sobra; estreite as outras para ela crescer'
              : '';
            return `<th data-ordem="${c.ordem}" data-ativa="${ativa}"
                        title="Ordenar por ${Utils.escapeHtml(c.rot)}${ativa ? ' (clique inverte)' : ''}${dica}"
                      ><span class="smax-gl-th-rot">${c.rot}</span> <span class="smax-gl-seta">${seta}</span>${alca}</th>`;
          }).join('')}</tr></thead>
          <tbody>${corpo}</tbody>
        </table>`;
    };

    /* ---------- Tela: graficos ----------
     * Le a mesma lista filtrada do painel, de proposito: grafico que ignora o
     * filtro da tela ao lado responde outra pergunta e ninguem percebe.
     *
     * Com UMA excecao, pedida em 2026-10-09: o filtro de arquivados nao vale
     * aqui. Arquivar serve para tirar da lista de trabalho o que ja acabou, e
     * nao para apagar o que aconteceu — se o grafico tambem obedecesse, bastaria
     * arquivar os encerrados para o "abertos x encerrados" virar 100% aberto e o
     * historico de meses encolher sozinho. Fica escrito no topo e no proprio
     * bloco de filtros, porque grafico que discorda da tabela ao lado sem avisar
     * e pior do que grafico nenhum.
     * Quantos globais entraram na conta fica escrito no topo. */
    const TOPO_FILHOS = 15;

    const renderGraficos = () => {
      if (vazio()) return vazio();

      const f = PgStore.prefs.filtros;
      const linhas = Metrica.listar({ ...f, verArquivados: true },
        PgStore.prefs.ordem, PgStore.prefs.ordemAsc);
      const g = Metrica.graficos(linhas);
      const lidoEm = PgStore.estado().lidoEm;
      const total = linhas.length;
      const qtArquivados = linhas.filter(l => l.arquivado).length;

      if (!lidoEm) {
        return `<div class="smax-gl-note smax-gl-note-warn">
          Nada foi lido do SMAX ainda, então três dos gráficos não têm o que mostrar
          (status, filhos e data de abertura vêm da leitura). Clique em
          <strong>↻ Atualizar do SMAX</strong> no rodapé.
        </div>${blocoFiltros({ arquivadosFixos: true })}`;
      }

      const cartoesEixo = g.porEixo.map(e => Graficos.cartao(
        `Globais por ${e.rotulo.toLowerCase()}`,
        e.base,
        Graficos.barrasH(e.itens, {
          acao: 'filtro-eixo',
          eixo: e.chave,
          ativos: f[e.chave] || [],
          vazio: `Nenhum global com ${e.rotulo.toLowerCase()} marcado.`
        }),
        // Obrigatorio dizer isto: a soma das barras passa do total de globais
        // porque um global pode estar marcado em mais de um valor do eixo. E e
        // exatamente por isso que estes nao podem ser pizza.
        `<strong>${e.marcacoes}</strong> marcações em <strong>${total}</strong> globais
         — a soma das barras passa do total quando um global tem mais de uma marcação.
         ${e.semMarca ? `<strong>${e.semMarca}</strong> sem nenhuma marcação neste eixo, fora do gráfico.` : ''}
         Clique numa barra para filtrar.`
      )).join('');

      const vida = Graficos.cartao(
        'Abertos × encerrados',
        g.vida.base,
        Graficos.barrasH([
          { id: 'abertos', nome: 'Abertos', valor: g.vida.abertos },
          { id: 'encerrados', nome: 'Encerrados', valor: g.vida.encerrados },
          { id: 'indefinidos', nome: 'Sem leitura', valor: g.vida.indefinidos }
        ]),
        `Encerrado é <strong>concluído, rejeitado ou cancelado</strong>. Suspenso conta como
         <strong>aberto</strong>: é o estado de escalado aguardando 3º nível, ou seja, trabalho vivo.
         ${g.vida.indefinidos
           ? `<strong>${g.vida.indefinidos}</strong> sem leitura ficam numa barra própria — não entram em “abertos” por omissão.`
           : ''}`
      );

      const topo = g.filhos.itens.slice(0, TOPO_FILHOS);
      const filhos = Graficos.cartao(
        'Filhos absorvidos por global',
        g.filhos.base,
        Graficos.barrasH(topo, {
          acao: 'abrir-chamado',
          vazio: 'Nenhum global com contagem de filhos lida.'
        }),
        `Maiores primeiro${g.filhos.itens.length > TOPO_FILHOS
          ? `, os <strong>${TOPO_FILHOS}</strong> do topo de <strong>${g.filhos.itens.length}</strong>`
          : ''}.
         ${g.filhos.semContagem
           ? `<strong>${g.filhos.semContagem}</strong> global(is) sem contagem lida ficam <em>fora</em> do gráfico — barra zero diria que não absorveram nada.`
           : ''}
         Clique numa barra para abrir o chamado no SMAX.`
      );

      const meses = `<section class="smax-gl-graf smax-gl-graf-wide">
        <div class="smax-gl-graf-h">
          <b>Globais abertos por mês</b>
          <span class="smax-gl-graf-base">${Utils.escapeHtml(g.meses.base)}</span>
        </div>
        ${Graficos.barrasV(g.meses.itens, { vazio: 'Nenhuma data de abertura lida.' })}
        <p class="smax-gl-graf-nota">
          Pela data de abertura do chamado no SMAX, não pela data em que ele entrou no painel.
          Mês sem nenhum global aparece com um traço, e não é omitido — pular mês vazio encosta
          as barras vizinhas e falseia a linha do tempo.
          ${g.meses.semData
            ? `<strong>${g.meses.semData}</strong> sem data de abertura lida, fora do gráfico.`
            : ''}
        </p>
      </section>`;

      return `
        <div class="smax-gl-note">
          Os gráficos contam os <strong>${total}</strong> globais que estão passando pelos filtros
          abaixo — os mesmos do Painel, <strong>menos o de arquivados</strong>.
          ${qtArquivados
            ? `<strong>${qtArquivados}</strong> ${qtArquivados === 1 ? 'está arquivado e continua' : 'estão arquivados e continuam'}
               contado${qtArquivados === 1 ? '' : 's'} aqui: arquivar tira da lista de trabalho, não do histórico.
               É por isso que o total acima pode ser maior do que o do Painel.`
            : 'Nenhum arquivado no momento — quando houver, ele continua entrando nesta conta.'}
          Estado lido do SMAX em
          <strong>${Utils.escapeHtml(Utils.formatBrDateTime(lidoEm))}</strong>.
        </div>
        ${blocoFiltros({ arquivadosFixos: true })}
        <div class="smax-gl-grafs">
          ${vida}
          ${filhos}
          ${cartoesEixo}
          ${meses}
        </div>`;
    };

    /* ---------- Tela: incluir global ---------- */
    const MOTIVOS = {
      inexistente: 'Não existe no SMAX.',
      'nao-global': 'Existe, mas não está marcado como “É global”.',
      filho: 'É filho de outro global.',
      repetido: 'Já está no painel.',
      erro: 'Não foi possível conferir.'
    };

    /* Os chips dos tres eixos. Tres telas marcam global — incluir, abrir e
     * reclassificar — e as tres tem de oferecer exatamente os mesmos valores;
     * uma copia a mais aqui era uma copia a mais para divergir.
     * `marcas` e um objeto de Set por eixo, mutado no lugar por quem trata o
     * clique. `alvo` so diz a quem pertencem os Sets, para o tratador saber. */
    const chipsEixos = (marcas, alvo) => Dados.EIXOS.map(e => {
      const vals = Dados.lista(e.chave);
      if (!vals.length) {
        return `<div class="smax-gl-label" style="margin-top:12px;">${e.rotulo}</div>
                <div class="smax-gl-note">Nenhum valor cadastrado. Crie em <strong>Configuração</strong>.</div>`;
      }
      return `
        <div class="smax-gl-label" style="margin-top:12px;">${e.rotulo}</div>
        <div class="smax-gl-chips">
          ${vals.map(v => `<button class="smax-gl-chip" data-act="chip-marca"
              data-alvo="${Utils.escapeHtml(alvo)}"
              data-eixo="${e.chave}" data-id="${Utils.escapeHtml(v.id)}"
              data-active="${marcas[e.chave].has(v.id)}">${Utils.escapeHtml(v.nome)}</button>`).join('')}
        </div>`;
    }).join('');

    /* ---------- Consultar (achar global que ja esta aberto) ---------- */

    const PERIODOS = [
      { dias: 7, rot: '7 dias' }, { dias: 30, rot: '30 dias' },
      { dias: 90, rot: '90 dias' }, { dias: 365, rot: '12 meses' },
      { dias: 0, rot: 'sem recorte' }
    ];
    const SITUACOES = [
      { id: 'abertos', rot: 'Abertos' },
      { id: 'encerrados', rot: 'Encerrados' },
      { id: 'todos', rot: 'Todos' }
    ];

    // Marcado QUE AINDA NAO ESTA NO PAINEL. A diferenca importa: depois de uma
    // inclusao o id continua no conjunto de marcados, e contar esses faria o
    // botao do rodape prometer um numero que ja entrou.
    const consultaMarcadosNovos = () => [...consultaUI.marcados].filter(id => !Dados.acharGlobal(id));

    /* A caixa de GSE. O recorte por GSE e o filtro que faz sentido para achar
     * global: procurar por texto do titulo nao da, porque `wordstartswith` nunca
     * foi visto funcionando em `Request` — so em Person, Location e PersonGroup —
     * e filtro recusado pelo SMAX volta VAZIO SEM ERRO, que a tela leria como
     * "nao existe nenhum". Por isso o recorte vai no campo que o servidor
     * reconhece: `AssignedToGroup`, por Id. */
    const renderGseBox = () => {
      const escolhidas = PgStore.prefs.consultaGses;
      const chips = escolhidas.length
        ? escolhidas.map(g => `
            <button class="smax-gl-chip" data-act="cons-gse-tirar" data-id="${Utils.escapeHtml(g.id)}"
                    data-active="true" title="Tirar do filtro">${Utils.escapeHtml(g.nome)} ✕</button>`).join('')
        : `<span class="smax-gl-person-msg" style="margin:0;">
             Nenhuma GSE escolhida — a consulta traz global de <strong>qualquer</strong> grupo.
           </span>`;

      const achados = gseUI.loading
        ? '<div class="smax-gl-person-msg">Buscando GSEs no SMAX…</div>'
        : gseUI.error
          ? `<div class="smax-gl-person-msg" style="color:var(--sp-danger-text);">${Utils.escapeHtml(gseUI.error)}</div>`
          : gseUI.results.length
            ? (() => {
                const faltam = gseUI.results.filter(g => !escolhidas.some(x => x.id === g.id));
                return `
                <div class="smax-gl-person-bulk">
                  <span>${gseUI.results.length} encontrada${gseUI.results.length === 1 ? '' : 's'} — clique para marcar; a busca fica aberta.</span>
                  <button class="smax-gl-btn" data-act="cons-gse-todas" ${faltam.length ? '' : 'disabled'}>
                    ${!faltam.length ? 'Todas já marcadas'
                      : faltam.length === 1 ? 'Marcar a que falta'
                      : `Marcar as ${faltam.length} que faltam`}
                  </button>
                </div>
                <div class="smax-gl-person-hits">${gseUI.results.map(g => {
                  const marcada = escolhidas.some(x => x.id === g.id);
                  return `
                  <button class="smax-gl-person-hit" data-act="cons-gse-escolher"
                          data-id="${Utils.escapeHtml(g.id)}" data-nome="${Utils.escapeHtml(g.nome)}"
                          data-current="${marcada}"
                          title="${marcada ? 'Clique para desmarcar' : 'Clique para marcar'}">
                    <span class="smax-gl-person-tick">${marcada ? '☑' : '☐'}</span>
                    <span style="flex:1 1 auto;min-width:0;">${Utils.escapeHtml(g.nome)}</span>
                    <small>${Utils.escapeHtml(g.id)}</small>
                  </button>`;
                }).join('')}</div>`;
              })()
            : `<div class="smax-gl-person-msg">${
                gseUI.term.trim().length < Grupos.MIN_CHARS
                  ? `Digite ao menos ${Grupos.MIN_CHARS} letras do nome da GSE.`
                  : 'Nenhuma GSE ativa com esse início de nome.'
              }</div>`;

      return `
        <div class="smax-gl-person">
          <div class="smax-gl-person-current">
            <div style="flex:1 1 auto; min-width:0; display:flex; gap:6px; flex-wrap:wrap;">${chips}</div>
            ${escolhidas.length > 1
              ? '<button class="smax-gl-btn" data-act="cons-gse-limpar" title="Tirar todas do filtro">Limpar GSEs</button>'
              : ''}
            <button class="smax-gl-btn" data-act="cons-gse-abrir">
              ${gseUI.open ? 'Fechar busca' : (escolhidas.length ? '+ Adicionar outras GSEs' : '+ Adicionar GSEs')}
            </button>
          </div>
          ${gseUI.open ? `
            <div class="smax-gl-person-search">
              <input id="smax-gl-gse-q" class="smax-gl-input" type="text"
                     placeholder="Início do nome — ex.: GSE SGS EPROC"
                     value="${Utils.escapeHtml(gseUI.term)}">
              ${achados}
            </div>` : ''}
        </div>`;
    };

    // Redesenha SO a caixa: um render() inteiro destruiria o foco e o caret do
    // campo de busca a cada tecla. Mesmo padrao do `refreshPersonBox`.
    const refreshGseBox = () => {
      const box = overlay && overlay.querySelector('#smax-gl-gse-box');
      if (!box) return;
      const input = box.querySelector('#smax-gl-gse-q');
      const tinhaFoco = input && document.activeElement === input;
      const caret = input ? input.selectionStart : null;
      box.innerHTML = renderGseBox();
      const novo = box.querySelector('#smax-gl-gse-q');
      if (novo && tinhaFoco) {
        novo.focus();
        if (caret != null) novo.setSelectionRange(caret, caret);
      }
    };

    const runGseSearch = (term) => {
      gseUI.term = term;
      const seq = ++gseUI.searchSeq;
      if (term.trim().length < Grupos.MIN_CHARS) {
        gseUI.loading = false;
        gseUI.error = '';
        gseUI.results = [];
        refreshGseBox();
        return;
      }
      gseUI.loading = true;
      gseUI.error = '';
      refreshGseBox();
      Grupos.search(term)
        .then((grupos) => {
          if (seq !== gseUI.searchSeq) return;   // resposta de uma busca ja superada
          gseUI.loading = false;
          gseUI.results = grupos;
          refreshGseBox();
        })
        .catch((err) => {
          if (seq !== gseUI.searchSeq) return;
          gseUI.loading = false;
          gseUI.results = [];
          gseUI.error = `Falha ao buscar GSE: ${PgApi.motivoDeErro(err)}`;
          refreshGseBox();
        });
    };

    const renderConsultar = () => {
      const c = consultaUI;
      const visiveis = c.itens;
      const faltaCarregar = c.buscou && c.lidos < c.total;

      const chipsPeriodo = PERIODOS.map(p => `
        <button class="smax-gl-chip" data-act="cons-dias" data-dias="${p.dias}"
                data-active="${c.dias === p.dias}">${p.rot}</button>`).join('');
      const chipsSituacao = SITUACOES.map(s => `
        <button class="smax-gl-chip" data-act="cons-situacao" data-sit="${s.id}"
                data-active="${c.situacao === s.id}">${s.rot}</button>`).join('');

      // O filtro enviado aparece junto com o erro de proposito: se a forma do
      // literal estiver errada, o que se precisa ver e a string exata.
      const blocoErro = c.erro ? `
        <div class="smax-gl-note" style="margin-top:14px; color:var(--sp-danger-text);">
          <strong>A consulta falhou:</strong> ${Utils.escapeHtml(c.erro)}
          ${c.filtro ? `<br><code style="font-size:11px;">filter=${Utils.escapeHtml(c.filtro)}</code>` : ''}
        </div>` : '';

      let resumo = '';
      if (c.buscando) {
        resumo = '<div class="smax-gl-note" style="margin-top:14px;">Consultando o SMAX…</div>';
      } else if (c.buscou && !c.erro) {
        const partes = [`O SMAX diz que existem <strong>${c.total}</strong> global(is) com esse filtro`];
        partes.push(`trazidos <strong>${c.lidos}</strong>`);
        if (c.descartados) partes.push(`<strong>${c.descartados}</strong> descartado(s) por serem filhos de outro global`);
        resumo = `<div class="smax-gl-note" style="margin-top:14px;">${partes.join(' · ')}.</div>`;
      }

      const lista = (!c.buscando && c.buscou && !c.erro) ? (
        visiveis.length ? visiveis.map((x) => {
          const jaTem = !!Dados.acharGlobal(x.id);
          const marcado = c.marcados.has(x.id);
          const st = Metrica.rotuloStatus(x.status) || '—';
          const stOp = Metrica.rotuloStatusOp(x.statusOp) || '';
          return `
            <div class="smax-gl-cand">
              <div class="smax-gl-cand-info">
                <div class="smax-gl-cand-title">
                  #${Utils.escapeHtml(x.id)}
                  ${jaTem ? '<span class="smax-gl-badge">já no painel</span>' : ''}
                </div>
                <div class="smax-gl-cand-meta">${Utils.escapeHtml(x.titulo || '(sem título)')}</div>
                <div class="smax-gl-cand-meta">
                  ${Utils.escapeHtml(st)}${stOp ? ` / ${Utils.escapeHtml(stOp)}` : ''}
                  ${x.grupo ? ` · ${Utils.escapeHtml(x.grupo)}` : ''}
                  ${x.criadoEm ? ` · aberto em ${Utils.escapeHtml(Utils.formatBrDateTime(x.criadoEm))}` : ''}
                </div>
                ${x.grupoEsp && x.grupoEsp !== x.grupo ? `
                  <div class="smax-gl-cand-meta" title="O filtro de GSE usa a designação atual (AssignedToGroup). Aqui os dois campos divergem.">
                    grupo especialista: ${Utils.escapeHtml(x.grupoEsp)}
                  </div>` : ''}
              </div>
              <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                <button class="smax-gl-btn" data-act="ver-global" data-id="${Utils.escapeHtml(x.id)}">Ver</button>
                ${jaTem
                  ? `<button class="smax-gl-btn" data-act="editar-global" data-id="${Utils.escapeHtml(x.id)}">Editar</button>`
                  : `<button class="smax-gl-chip" data-act="cons-marcar" data-id="${Utils.escapeHtml(x.id)}"
                             data-active="${marcado}">${marcado ? '✓ marcado' : 'marcar'}</button>`}
              </div>
            </div>`;
        }).join('')
          : `<div class="smax-gl-note" style="margin-top:14px;">
               Nenhum global nesse filtro.
               ${c.total && c.descartados === c.lidos ? 'Todos os que voltaram eram filhos de outro global.' : ''}
             </div>`
      ) : '';

      // Marcar em massa so faz sentido sobre os que ainda podem entrar: os que
      // ja estao no painel nao tem nem chip de marcar.
      const marcaveis = visiveis.filter(x => !Dados.acharGlobal(x.id)).length;
      const acoesLista = (!c.buscando && c.buscou && !c.erro && visiveis.length) ? `
        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
          ${marcaveis ? `<button class="smax-gl-btn" data-act="cons-marcar-visiveis">
              ${marcaveis === 1 ? 'Marcar o único que pode entrar' : `Marcar os ${marcaveis} da lista`}</button>` : ''}
          ${consultaMarcadosNovos().length ? '<button class="smax-gl-btn" data-act="cons-desmarcar">Desmarcar tudo</button>' : ''}
          ${faltaCarregar ? `<button class="smax-gl-btn" data-act="cons-mais">
              Carregar mais (faltam ${c.total - c.lidos})</button>` : ''}
        </div>` : '';

      /* Desfecho da ultima inclusao. Fica na tela porque incluir em lote tem
       * recusa individual — e recusa que nao aparece em lugar nenhum vira
       * "marquei 5, entraram 3" sem explicacao. */
      const blocoResultados = c.resultados.length ? `
        <div class="smax-gl-label" style="margin-top:18px;">Última inclusão</div>
        ${c.resultados.map(r => `
          <div class="smax-gl-cand">
            <div class="smax-gl-cand-info">
              <div class="smax-gl-cand-title">
                #${Utils.escapeHtml(r.id)}
                ${r.estado === 'incluido'
                  ? '<span class="smax-gl-badge smax-gl-badge-best">incluído</span>'
                  : '<span class="smax-gl-badge">não entrou</span>'}
              </div>
              <div class="smax-gl-cand-meta">
                ${r.estado === 'incluido'
                  ? Utils.escapeHtml(r.titulo || '(sem título)')
                  : Utils.escapeHtml(r.motivo || MOTIVOS[r.estado] || 'Recusado.')}
              </div>
            </div>
          </div>`).join('')}` : '';

      /* Classificar aqui, e nao numa segunda aba: a decisao de assunto/base/
       * competencia e tomada LENDO o chamado, e e nesta tela que da para ler
       * (botao Ver em cada linha). So aparece quando ha alguem marcado — bloco
       * de classificacao sem ninguem para classificar e so ruido. */
      const marcadosNovos = consultaMarcadosNovos();
      const blocoClassificar = marcadosNovos.length ? `
        <div class="smax-gl-label" style="margin-top:20px;">
          Classificação — vale para ${marcadosNovos.length === 1 ? 'o global marcado' : `os ${marcadosNovos.length} globais marcados`}
        </div>
        <div class="smax-gl-note">
          Dá para marcar mais de um valor por eixo. Para classificar de formas diferentes,
          inclua em levas: marque uns, inclua, marque os outros.
        </div>
        ${chipsEixos(c.marcas, 'consulta')}
        <div class="smax-gl-label" style="margin-top:14px;">Nota (opcional)</div>
        <input class="smax-gl-input" id="smax-gl-cons-nota" type="text" style="width:100%;"
               value="${Utils.escapeHtml(c.nota)}" placeholder="texto livre">` : '';

      return `
        <div class="smax-gl-note">
          Procura no SMAX os chamados marcados como <strong>“É global”</strong>. O recorte por
          <strong>GSE</strong>, período e situação vai para o servidor. Quem é filho de outro global
          sai da lista — isso não dá para filtrar no servidor, então o descarte acontece aqui e o
          número aparece no resumo. Use <strong>Ver</strong> para ler o chamado, marque os que
          interessam, classifique e inclua sem sair daqui.
        </div>

        <div class="smax-gl-label" style="margin-top:14px;">GSE (designação atual do chamado)</div>
        <div id="smax-gl-gse-box">${renderGseBox()}</div>

        <div class="smax-gl-label" style="margin-top:14px;">Aberto nos últimos</div>
        <div class="smax-gl-chips">${chipsPeriodo}</div>

        <div class="smax-gl-label" style="margin-top:12px;">Situação</div>
        <div class="smax-gl-chips">${chipsSituacao}</div>

        <div style="display:flex; gap:8px; margin-top:14px;">
          <button class="smax-gl-btn smax-gl-btn-primary" data-act="cons-buscar" ${c.buscando ? 'disabled' : ''}>
            ${c.buscando ? 'Consultando…' : '🔍 Consultar o SMAX'}
          </button>
          ${c.buscou ? '<button class="smax-gl-btn" data-act="cons-limpar">Limpar</button>' : ''}
        </div>

        ${blocoErro}
        ${resumo}
        ${acoesLista}
        ${lista}
        ${blocoResultados}
        ${blocoClassificar}`;
    };

    const renderIncluir = () => {
      const r = incluirUI;
      const aprovados = r.resultados.filter(x => x.estado === 'ok');
      const chips = chipsEixos(r.marcas, 'incluir');

      const listaResultados = r.resultados.length ? `
        <div class="smax-gl-label" style="margin-top:18px;">
          Conferência — ${aprovados.length} de ${r.resultados.length} pode(m) entrar
        </div>
        ${r.resultados.map(x => `
          <div class="smax-gl-cand">
            <div class="smax-gl-cand-info">
              <div class="smax-gl-cand-title">
                #${Utils.escapeHtml(x.id)}
                ${x.estado === 'ok'
                  ? '<span class="smax-gl-badge smax-gl-badge-best">pode entrar</span>'
                  : `<span class="smax-gl-badge">recusado</span>`}
              </div>
              <div class="smax-gl-cand-meta">
                ${x.estado === 'ok'
                  ? Utils.escapeHtml(x.titulo || '(sem título)')
                  : Utils.escapeHtml(x.motivo || MOTIVOS[x.estado] || 'Recusado.')}
              </div>
            </div>
          </div>`).join('')}` : '';

      return `
        <div class="smax-gl-note">
          Cole um ou vários números de chamado. O script confere cada um no SMAX antes de incluir:
          tem de existir, estar marcado como <strong>“É global”</strong>, não ser filho de outro
          global e ainda não estar no painel.
          <br>Não sabe o número? Procure na aba <strong>Consultar</strong> e mande os marcados para cá.
        </div>

        <div class="smax-gl-label">Números dos chamados</div>
        <textarea class="smax-gl-input" id="smax-gl-ids" rows="3" style="width:100%; resize:vertical;"
                  placeholder="82133910 82140011 — separados por espaço, vírgula ou linha">${Utils.escapeHtml(r.texto)}</textarea>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="smax-gl-btn smax-gl-btn-primary" data-act="conferir-ids" ${r.verificando ? 'disabled' : ''}>
            ${r.verificando ? 'Conferindo…' : 'Conferir no SMAX'}
          </button>
          ${r.resultados.length ? '<button class="smax-gl-btn" data-act="limpar-conferencia">Limpar</button>' : ''}
        </div>

        ${listaResultados}

        <div class="smax-gl-label" style="margin-top:20px;">Classificação</div>
        <div class="smax-gl-note">Vale para todos os chamados desta inclusão. Dá para marcar mais de um valor por eixo.</div>
        ${chips}

        <div class="smax-gl-label" style="margin-top:14px;">Nota (opcional)</div>
        <input class="smax-gl-input" id="smax-gl-nota" type="text" style="width:100%;"
               value="${Utils.escapeHtml(r.nota)}" placeholder="texto livre">`;
    };

    /* ---------- Novidades (fase 6) ---------- */

    // `GM_notification` pode nao existir: a permissao e nova na v1.15, e o
    // Tampermonkey so a concede depois de o usuario aceitar a atualizacao do
    // script. Antes disso a funcao simplesmente nao esta definida.
    const temNotificacao = () => typeof GM_notification === 'function';

    const proximaTexto = () => {
      const p = PgMonitor.proxima();
      if (!PgStore.prefs.monitor.ligado) return '<br>Monitoramento <strong>desligado</strong>.';
      if (!p) return '<br>Primeira sondagem sendo agendada.';
      const faltam = Math.max(0, Math.round((p - Date.now()) / 60000));
      return `<br>Próxima sondagem ${faltam <= 0 ? 'no próximo minuto' : `em ~${faltam} min`}
              (<strong>${Utils.escapeHtml(Utils.formatBrDateTime(p))}</strong>).`;
    };

    const renderNovidades = () => {
      const n = PgStore.novidades();
      const vistoEm = n.vistoEm;
      if (!n.itens.length) {
        return `
          <div class="smax-gl-note">
            Nada registrado ainda. O monitor compara cada leitura com a anterior e anota aqui o que
            mudou nos globais não arquivados: filhos novos, troca de status, troca de grupo e
            alteração genérica.
            ${PgStore.prefs.monitor.ligado
              ? proximaTexto()
              : '<br><strong>O monitoramento está desligado</strong> — ligue em Configuração, ou use “↻ Atualizar do SMAX”, que também compara.'}
          </div>`;
      }

      const itens = n.itens.map((x) => {
        const t = PgMonitor.TIPOS[x.tipo] || { rot: x.tipo };
        return `
          <div class="smax-gl-nov-item" data-novo="${Number(x.quando) > vistoEm}">
            <span class="smax-gl-nov-tipo" data-tipo="${Utils.escapeHtml(x.tipo)}">${Utils.escapeHtml(t.rot)}</span>
            <div>
              <div class="smax-gl-nov-tit"><b>#${Utils.escapeHtml(x.id)}</b> ${Utils.escapeHtml(x.titulo || '(sem título)')}</div>
              <div class="smax-gl-nov-txt">${Utils.escapeHtml(x.texto)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="smax-gl-nov-quando">${Utils.escapeHtml(Utils.formatBrDateTime(x.quando))}</span>
              <button class="smax-gl-btn" data-act="ver-global" data-id="${Utils.escapeHtml(x.id)}">Ver</button>
            </div>
          </div>`;
      }).join('');

      const naoVistas = n.itens.filter(x => Number(x.quando) > vistoEm).length;
      return `
        <div class="smax-gl-note">
          O que mudou nos globais da lista desde a leitura anterior.
          ${naoVistas ? `<strong>${naoVistas}</strong> ainda não vista(s).` : 'Todas vistas.'}
          Guarda as ${PgStore.MAX_NOVID} mais recentes.${proximaTexto()}
        </div>
        <div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;">
          <button class="smax-gl-btn" data-act="novid-vistas" ${naoVistas ? '' : 'disabled'}>Marcar todas como vistas</button>
          <button class="smax-gl-btn smax-gl-btn-danger" data-act="novid-limpar">Limpar histórico</button>
        </div>
        <div class="smax-gl-nov">${itens}</div>`;
    };

    const renderConfig = () => {
      const d = PgStore.dados();
      const pp = PgStore.prefs;
      const temToken = !!(pp.githubToken || '').trim();
      const mon = pp.monitor;

      const eixosBlock = Dados.EIXOS.map(e => {
        const vals = Dados.lista(e.chave);
        const itens = vals.length
          ? vals.map(v => `
              <div class="smax-gl-cand">
                <div class="smax-gl-cand-info">
                  <div class="smax-gl-cand-title">${Utils.escapeHtml(v.nome)}</div>
                  <div class="smax-gl-cand-meta">usado em ${Dados.contarUsos(e.chave, v.id)} global(is)</div>
                </div>
                <button class="smax-gl-btn" data-act="renomear-valor"
                        data-eixo="${e.chave}" data-id="${Utils.escapeHtml(v.id)}">Renomear</button>
                <button class="smax-gl-btn smax-gl-btn-danger" data-act="remover-valor"
                        data-eixo="${e.chave}" data-id="${Utils.escapeHtml(v.id)}">Remover</button>
              </div>`).join('')
          : '<div class="smax-gl-note">Nenhum valor cadastrado ainda.</div>';

        return `
          <div class="smax-gl-label" style="margin-top:16px;">${e.rotulo} (${vals.length})</div>
          ${itens}
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input class="smax-gl-input" id="smax-gl-novo-${e.chave}" type="text" style="flex:1 1 auto;"
                   placeholder="Novo valor${e.exemplo ? ` — ex.: ${Utils.escapeHtml(e.exemplo)}` : ''}">
            <button class="smax-gl-btn smax-gl-btn-primary" data-act="criar-valor" data-eixo="${e.chave}">Criar</button>
          </div>`;
      }).join('');

      return `
        <div class="smax-gl-note">
          <strong>Listas de classificação.</strong> São de criação livre e valem para os três eixos do
          painel. Renomear é seguro: a marcação guarda o código do valor, não o nome.
          Criar um valor que já existe só com outra caixa ou acento
          (“mandados” depois de “Mandados”) <strong>não</strong> cria um valor novo.
        </div>
        ${eixosBlock}

        <div class="smax-gl-label" style="margin-top:22px;">Arquivo compartilhado</div>
        <div class="smax-gl-note">
          Versão local: <strong>${d._version}</strong>${d._updatedAt ? ` · publicada em ${Utils.escapeHtml(d._updatedAt)}` : ' · nunca publicada daqui'}<br>
          ${d.globais.length} global(is) na lista ·
          ${Dados.EIXOS.map(e => `${Dados.lista(e.chave).length} ${e.rotulo.toLowerCase()}`).join(' · ')}
        </div>
        <input class="smax-gl-input" id="smax-gl-arquivo-url" type="text" style="width:100%;"
               placeholder="https://raw.githubusercontent.com/dono/repo/branch/painel-globais.json"
               value="${Utils.escapeHtml(urlDigitada !== null ? urlDigitada : (pp.arquivoUrl || ''))}">
        <input class="smax-gl-input" id="smax-gl-gh-token" type="password" style="width:100%; margin-top:8px;"
               placeholder="${temToken ? 'Token salvo — preencha só para trocar' : 'Token do GitHub (só para publicar)'}"
               value="" autocomplete="off">
        <div class="smax-gl-note" style="margin-top:8px;">
          O token fica apenas neste navegador e <strong>nunca</strong> vai para o arquivo publicado.
          Sem token o painel ainda importa — só não publica.
        </div>
        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
          <button class="smax-gl-btn" data-act="salvar-git">Salvar URL e token</button>
          <button class="smax-gl-btn" data-act="importar-git">⬇ Importar do GitHub</button>
          <button class="smax-gl-btn smax-gl-btn-primary" data-act="publicar-git" ${temToken ? '' : 'disabled'}>
            ⬆ Publicar no GitHub
          </button>
        </div>

        <div class="smax-gl-label" style="margin-top:22px;">Monitoramento</div>
        <div class="smax-gl-note">
          Em segundo plano, o script sonda os globais <strong>não arquivados</strong> da lista e
          registra o que mudou na aba <strong>Novidades</strong>. A sondagem é barata: uma consulta
          por global, sem trazer os registros. Só quando algum número se move é que ele faz a
          leitura completa — e apenas nos globais afetados.
          ${proximaTexto()}
        </div>
        <!-- Chip, e nao caixa de marcar: o CSS do SMAX zera a aparencia de
             input[type=checkbox] e escopar numa classe raiz nao resolve controle
             de formulario (analise §18.2 item 32, medido no Localizador). O
             script inteiro nao tem uma caixa de marcar por esse motivo. -->
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <button class="smax-gl-chip" data-act="mon-ligado" data-active="${mon.ligado}">
            ${mon.ligado ? '● Monitorando' : '○ Desligado'}
          </button>
          <span class="smax-gl-note" style="margin:0;">sondar a cada</span>
          <select class="smax-gl-select" data-act="mon-minutos" style="width:auto;">
            ${[10, 30, 60].map(m => `<option value="${m}" ${mon.minutos === m ? 'selected' : ''}>${m} minutos</option>`).join('')}
          </select>
          <button class="smax-gl-chip" data-act="mon-so" data-active="${mon.notificarSO}">
            ${mon.notificarSO ? '🔔 Notifica no sistema' : '🔕 Só na página'}
          </button>
        </div>
        <div class="smax-gl-note" style="margin-top:6px;">
          O selo no botão flutuante e o aviso na tela aparecem sempre. A notificação do sistema é
          opcional porque <strong>pode não chegar</strong>: o Assistente de Foco do Windows a
          engole sem avisar, e aviso que às vezes não chega não serve como canal único.
          ${temNotificacao() ? '' : '<br><strong>Indisponível neste navegador/Tampermonkey</strong> — a permissão <code>GM_notification</code> não está concedida.'}
        </div>`;
    };

    /* ---------- Render ---------- */
    const render = () => {
      if (!overlay) return;
      const body = overlay.querySelector('.smax-gl-body');
      const footer = overlay.querySelector('.smax-gl-footer-actions');

      overlay.querySelectorAll('.smax-gl-tab').forEach(t => {
        t.dataset.active = String(t.dataset.tab === activeTab);
      });

      body.innerHTML = activeTab === 'painel' ? renderPainel()
        : activeTab === 'graficos' ? renderGraficos()
        : activeTab === 'novidades' ? renderNovidades()
        : activeTab === 'abrir' ? renderAbrir()
        : activeTab === 'consultar' ? renderConsultar()
        : activeTab === 'incluir' ? renderIncluir()
        : activeTab === 'config' ? renderConfig()
        : renderAprender();

      // Restaura o conteudo dos editores (innerHTML nao sobrevive ao re-render)
      const desc = body.querySelector('#smax-gl-desc');
      if (desc) desc.innerHTML = form.descriptionHtml;
      const contorno = body.querySelector('#smax-gl-contorno');
      if (contorno) contorno.innerHTML = form.contornoHtml;

      // Abas que so leem o que ja esta no painel: o rodape delas e o botao de
      // reler o SMAX. As outras tem acao propria (criar, incluir).
      const abasDeLeitura = activeTab === 'painel' || activeTab === 'graficos' || activeTab === 'novidades';
      if (abasDeLeitura) {
        footer.innerHTML = `<button class="smax-gl-btn smax-gl-btn-primary" data-act="atualizar-smax"
             ${busy ? 'disabled' : ''}>${busy ? 'Lendo…' : '↻ Atualizar do SMAX'}</button>`;
      } else if (activeTab === 'abrir' && prefs.molde) {
        footer.innerHTML = `<button class="smax-gl-btn" data-act="preview">Ver payload</button>
           <button class="smax-gl-btn smax-gl-btn-primary" data-act="criar" ${busy ? 'disabled' : ''}>
             ${busy ? 'Criando…' : '🌐 Abrir chamado global'}
           </button>`;
      } else if (activeTab === 'consultar') {
        const n = consultaMarcadosNovos().length;
        const incluindo = consultaUI.incluindo;
        footer.innerHTML = `<button class="smax-gl-btn smax-gl-btn-primary" data-act="cons-incluir"
             ${n && !busy && !incluindo ? '' : 'disabled'}>
             ${incluindo ? 'Incluindo…'
               : !n ? 'Incluir marcados'
               : n === 1 ? 'Incluir o marcado'
               : `Incluir os ${n} marcados`}
           </button>`;
      } else if (activeTab === 'incluir') {
        const n = incluirUI.resultados.filter(x => x.estado === 'ok').length;
        footer.innerHTML = `<button class="smax-gl-btn smax-gl-btn-primary" data-act="incluir-aprovados"
             ${n && !busy ? '' : 'disabled'}>
             ${busy ? 'Incluindo…' : `Incluir no painel (${n})`}
           </button>`;
      } else {
        footer.innerHTML = '';
      }

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

    // Modal de confirmacao com conteudo livre. Existe porque a importacao tem
    // de mostrar o que vai mudar ANTES de substituir o dado curado.
    const askModal = (title, contentHtml, okLabel) => new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'smax-gl-overlay smax-gl-modal smax-gl-root';
      wrap.dataset.theme = ThemeManager.current();
      wrap.innerHTML = `
        <div class="smax-gl-panel" style="width:min(640px,94vw);">
          <div class="smax-gl-header"><h2>${Utils.escapeHtml(title)}</h2></div>
          <div class="smax-gl-body">${contentHtml}</div>
          <div class="smax-gl-footer">
            <div class="smax-gl-status"></div>
            <button class="smax-gl-btn" data-act="cancelar">Cancelar</button>
            <button class="smax-gl-btn smax-gl-btn-primary" data-act="ok">${Utils.escapeHtml(okLabel)}</button>
          </div>
        </div>`;
      const fim = (r) => { wrap.remove(); resolve(r); };
      wrap.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (!act) { if (ev.target === wrap) fim(false); return; }
        fim(act === 'ok');
      });
      document.body.appendChild(wrap);
    });

    /* Arquivar em lote os encerrados da tela. Confirma mostrando a lista inteira
     * — numero e barato de ler errado, e aqui some linha da tela de quem olha o
     * painel todo dia. A lista e relida DEPOIS do "ok": o modal e assincrono e
     * nesse meio-tempo uma rodada de atualizacao pode ter mudado status. */
    const arquivarEncerrados = async () => {
      const antes = encerradosNaTela();
      if (!antes.length) { setStatus('Nenhum encerrado nesta tela.', 'err'); return; }
      const corpo = `
        <div class="smax-gl-note">
          Vai sair da lista do painel, mas <strong>continua no arquivo e nos gráficos</strong>.
          Marcações, nota e data de inclusão ficam como estão. Para trazer de volta,
          ligue <strong>Arquivados: mostrando</strong> nos filtros e clique em <strong>Reabrir</strong>.
        </div>
        <ul style="margin:8px 0 0 18px;padding:0;">
          ${antes.map(l => `<li>#${Utils.escapeHtml(l.id)} — ${Utils.escapeHtml(l.titulo || '(sem título)')}
             <em>(${Utils.escapeHtml(Metrica.rotuloStatus(l.status))})</em></li>`).join('')}
        </ul>`;
      if (!(await askModal(`Arquivar ${antes.length} encerrado(s)`, corpo, 'Arquivar'))) {
        setStatus('Arquivamento cancelado.');
        return;
      }
      const alvos = encerradosNaTela();
      let n = 0;
      alvos.forEach((l) => { if (Dados.arquivar(l.id, true).ok) n++; });
      render();
      setStatus(n === alvos.length
        ? `${n} global(is) arquivado(s).`
        : `${n} de ${alvos.length} arquivado(s) — o resto já não estava no painel.`, n ? 'ok' : 'err');
    };

    /* ---------- Visualizador de chamado ----------
     * Antes disto a unica forma de ler um global era clicar no numero e sair do
     * painel para a tela do SMAX, perdendo filtro e ordenacao. O modal responde
     * "do que se trata este?" sem tirar ninguem da lista; nao substitui a tela
     * nativa, e por isso tem o link para ela no rodape.
     *
     * TODO o HTML aqui vem de fora e passa por `Utils.sanitizeRichText`, que usa
     * DOMParser. Nao e paranoia de rotina: descricao de chamado e escrita por
     * qualquer solicitante, e comentario tambem — e esta e a primeira tela do
     * painel que renderiza HTML de terceiro em vez de texto escapado. */
    const corpoRico = (html, vazioMsg) => {
      const limpo = Utils.sanitizeRichText(Utils.unescapeIfDoubleEscaped(html));
      // Checa o TEXTO, nao o HTML: `<p>&nbsp;</p>` tem 13 caracteres de HTML e
      // nada de conteudo, e dizer "tem descricao" nesse caso e mentir.
      if (!Utils.htmlToText(limpo)) {
        return `<div class="smax-gl-note">${Utils.escapeHtml(vazioMsg)}</div>`;
      }
      return `<div class="smax-gl-rico">${limpo}</div>`;
    };

    const verModal = (id) => {
      const wrap = document.createElement('div');
      wrap.className = 'smax-gl-overlay smax-gl-modal smax-gl-root';
      wrap.dataset.theme = ThemeManager.current();
      const painel = () => wrap.querySelector('.smax-gl-body');
      wrap.innerHTML = `
        <div class="smax-gl-panel" style="width:min(900px,96vw);max-height:92vh;">
          <div class="smax-gl-header">
            <h2>#${Utils.escapeHtml(id)}</h2>
            <div class="smax-gl-header-actions"><button data-act="fechar">✕</button></div>
          </div>
          <div class="smax-gl-body" style="overflow:auto;">
            <div class="smax-gl-note">Lendo o chamado no SMAX...</div>
          </div>
          <div class="smax-gl-footer">
            <div class="smax-gl-status"></div>
            <a class="smax-gl-btn" href="/saw/Request/${Utils.escapeHtml(id)}/general" target="_blank"
               style="text-decoration:none;">Abrir no SMAX</a>
            <button class="smax-gl-btn" data-act="fechar">Fechar</button>
          </div>
        </div>`;
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-act="fechar"]')) wrap.remove();
      });
      document.body.appendChild(wrap);

      // O que o painel JA sabe deste global, que a leitura do chamado nao tem:
      // marcacoes e nota sao dado local.
      const g = Dados.acharGlobal(id);
      const marcasLocais = g
        ? Dados.EIXOS.flatMap(e => (g[e.chave] || []).map(vid => Dados.nomeDe(e.chave, vid)).filter(Boolean))
        : [];

      PgApi.lerChamado(id).then((c) => {
        // O modal pode ter sido fechado durante a leitura. Escrever no DOM de um
        // no removido nao da erro, mas reabriria nada — so sai fora.
        if (!wrap.isConnected) return;
        const campo = (rot, val) => `<div><span class="smax-gl-label">${rot}</span>
          <div>${val}</div></div>`;
        const discussao = c.comentarios.length
          ? c.comentarios.map(cm => `
              <div class="smax-gl-coment ${cm.interno ? 'smax-gl-coment-int' : ''}">
                <div class="smax-gl-cand-meta">
                  ${Utils.escapeHtml(Utils.formatBrDateTime(cm.quando))}
                  ${cm.interno
                    ? '<span class="smax-gl-badge smax-gl-badge-warn" title="O solicitante não vê este comentário.">interno</span>'
                    : '<span class="smax-gl-badge">público</span>'}
                </div>
                ${corpoRico(cm.corpo, '(comentário vazio)')}
              </div>`).join('')
          : `<div class="smax-gl-note">${c.erroDiscussao
               ? Utils.escapeHtml(c.erroDiscussao)
               : 'Nenhum comentário de pessoa. Os lançamentos automáticos do SMAX ficam de fora.'}</div>`;

        painel().innerHTML = `
          <h3 style="margin:0 0 10px;">${Utils.escapeHtml(c.titulo || '(sem título)')}</h3>
          <div class="smax-gl-ver-dados">
            ${campo('Status', Utils.escapeHtml(Metrica.rotuloStatus(c.status) || '—'))}
            ${campo('Operacional', Utils.escapeHtml(Metrica.rotuloStatusOp(c.statusOp) || '—'))}
            ${campo('Grupo', Utils.escapeHtml(c.grupo || '—'))}
            ${campo('Abertura', Utils.escapeHtml(Utils.formatBrDateTime(c.criadoEm)))}
            ${campo('Última alteração', Utils.escapeHtml(Utils.formatBrDateTime(c.atualizadoEm)))}
            ${campo('Classificação no painel', marcasLocais.length
              ? marcasLocais.map(n => `<span class="smax-gl-marca">${Utils.escapeHtml(n)}</span>`).join('')
              : '<span class="smax-gl-naolido">sem marcação</span>')}
          </div>
          ${g && g.nota ? `<div class="smax-gl-note">Nota do painel: ${Utils.escapeHtml(g.nota)}</div>` : ''}
          <div class="smax-gl-label" style="margin-top:14px;">Descrição</div>
          ${corpoRico(c.descricao, 'Sem descrição.')}
          <div class="smax-gl-label" style="margin-top:14px;">Solução</div>
          ${corpoRico(c.solucao, 'Sem solução registrada.')}
          <div class="smax-gl-label" style="margin-top:14px;">Discussão</div>
          ${discussao}`;
      }).catch((err) => {
        if (!wrap.isConnected) return;
        painel().innerHTML = `<div class="smax-gl-note smax-gl-note-err">
          Não foi possível ler o chamado: ${Utils.escapeHtml(PgApi.motivoDeErro(err))}
          ${err.formaInesperada
            ? '<br>A resposta chegou, mas num formato diferente do esperado — pode ser mudança de versão do SMAX.'
            : ''}
          <br>Use <strong>Abrir no SMAX</strong> no rodapé: a tela nativa continua funcionando.
        </div>`;
      });
    };

    /* Reclassificar um global que ja esta no painel. Antes disto a unica saida
     * para uma marcacao errada era remover e incluir de novo — e remover apaga a
     * nota e a data de inclusao, ou seja, consertar o erro custava dado bom.
     * O modal mexe em copias dos Sets e so grava no "Salvar": fechar no X ou no
     * fundo tem de deixar o painel exatamente como estava. */
    const editarModal = (global) => {
      const marcas = {
        assunto: new Set(global.assunto || []),
        base: new Set(global.base || []),
        competencia: new Set(global.competencia || [])
      };
      const wrap = document.createElement('div');
      wrap.className = 'smax-gl-overlay smax-gl-modal smax-gl-root';
      wrap.dataset.theme = ThemeManager.current();
      wrap.innerHTML = `
        <div class="smax-gl-panel" style="width:min(640px,94vw);">
          <div class="smax-gl-header">
            <h2>Reclassificar #${Utils.escapeHtml(global.id)}</h2>
            <div class="smax-gl-header-actions"><button data-act="fechar">✕</button></div>
          </div>
          <div class="smax-gl-body">
            ${chipsEixos(marcas, 'modal')}
            <div class="smax-gl-field" style="margin-top:12px;">
              <label class="smax-gl-label" for="smax-gl-edit-nota">Nota</label>
              <input id="smax-gl-edit-nota" class="smax-gl-input" type="text"
                     value="${Utils.escapeHtml(global.nota || '')}"
                     placeholder="Observação livre sobre este global...">
            </div>
          </div>
          <div class="smax-gl-footer">
            <div class="smax-gl-status"></div>
            <button class="smax-gl-btn" data-act="fechar">Cancelar</button>
            <button class="smax-gl-btn smax-gl-btn-primary" data-act="salvar">Salvar</button>
          </div>
        </div>`;
      wrap.addEventListener('click', (ev) => {
        const alvo = ev.target.closest('[data-act]');
        const act = alvo?.dataset.act;
        if (!act) { if (ev.target === wrap) wrap.remove(); return; }
        if (act === 'fechar') { wrap.remove(); return; }
        if (act === 'chip-marca') {
          // Alterna no lugar: redesenhar o modal inteiro apagaria a nota digitada.
          const conj = marcas[alvo.dataset.eixo];
          const marcado = conj.has(alvo.dataset.id);
          marcado ? conj.delete(alvo.dataset.id) : conj.add(alvo.dataset.id);
          alvo.dataset.active = String(!marcado);
          return;
        }
        if (act === 'salvar') {
          const nota = wrap.querySelector('#smax-gl-edit-nota').value;
          const r = Dados.atualizarMarcas(global.id, marcas, nota);
          wrap.remove();
          render();
          setStatus(r.msg, r.ok ? 'ok' : 'err');
        }
      });
      document.body.appendChild(wrap);
    };

    /* ---------- Atualizar o estado a partir do SMAX ---------- */
    const atualizarDoSmax = async () => {
      if (busy) return;
      const ids = PgStore.dados().globais.map(g => g.id);
      if (!ids.length) { setStatus('Nada para atualizar: o painel está vazio.', 'err'); return; }
      busy = true;
      render();
      try {
        setStatus(`Lendo o estado de ${ids.length} global(is)…`);
        // A leitura mora no PgMonitor desde a fase 6, e nao aqui, porque a rodada
        // automatica precisa dela com o painel fechado. O diff contra o estado
        // anterior vem junto: atualizar a mao tambem produz novidade.
        const { est, fil, novidades, ausentes } = await PgMonitor.lerTudo(ids, (etapa, f, t) => {
          if (!t) setStatus(etapa === 'estado' ? 'Lendo o estado…' : 'Contando os filhos…');
          else setStatus(`${etapa === 'estado' ? 'Estado' : 'Filhos'}: bloco ${f} de ${t}…`);
        });

        const avisos = [];
        if (est.falhas.length) {
          const quantos = est.falhas.reduce((s, x) => s + x.ids.length, 0);
          // "nao relido" e nao "sem leitura": quem ja tinha sido lido antes segue
          // na tela com o horario antigo na coluna LIDO. Dizer "sem leitura" aqui
          // contradizia o cartao de resumo, que conta so quem nunca foi lido.
          avisos.push(`${quantos} não puderam ser relidos agora (${est.falhas[0].motivo})`);
        }
        if (fil.falhas.length) {
          const quantos = fil.falhas.reduce((s, x) => s + x.ids.length, 0);
          avisos.push(`${quantos} sem contagem de filhos (${fil.falhas[0].motivo})`);
        }
        if (ausentes.length) avisos.push(`${ausentes.length} não voltaram do SMAX (apagados ou sem permissão): ${ausentes.slice(0, 5).join(', ')}`);

        const nov = novidades.length
          ? ` ${novidades.length} novidade(s) — veja a aba Novidades.`
          : '';
        setStatus(
          avisos.length
            ? `Atualizado com ressalva — ${avisos.join('; ')}.${nov}`
            : `Atualizado: ${Object.keys(est.porId).length} global(is) lido(s).${nov}`,
          avisos.length ? 'err' : 'ok'
        );
      } catch (err) {
        setStatus(`Falha ao atualizar: ${PgApi.motivoDeErro(err)}`, 'err');
      } finally {
        // Antes do render: senao o botao continuaria desabilitado.
        busy = false;
        render();
      }
    };

    /* ---------- Incluir global ---------- */
    const lerIdsDigitados = () => {
      const el = overlay.querySelector('#smax-gl-ids');
      const txt = el ? el.value : incluirUI.texto;
      // Aceita espaco, virgula, ponto-e-virgula, quebra de linha e "#" na frente.
      const achados = (txt.match(/\d{3,}/g) || []);
      return { txt, ids: [...new Set(achados)] };
    };

    /* ---------- Consultar ---------- */

    // A nota mora num <input>, e `render()` reescreve o corpo inteiro: sem ler
    // o campo antes de qualquer re-render, o que o usuario digitou desaparece.
    const lerNotaConsulta = () => {
      const el = overlay.querySelector('#smax-gl-cons-nota');
      if (el) consultaUI.nota = el.value;
    };

    const DIA_MS = 86400000;

    const gsesEscolhidas = () => PgStore.prefs.consultaGses.map(g => g.id);

    const consultar = async (continuando) => {
      if (consultaUI.buscando) return;
      lerNotaConsulta();
      const c = consultaUI;
      const desde = c.dias ? Date.now() - c.dias * DIA_MS : 0;
      // Lido UMA vez e usado na contagem e em todas as paginas: se o usuario
      // mexesse nas GSEs no meio da paginacao, o `skip` cairia em outro
      // resultado e a lista misturaria duas consultas.
      const grupos = continuando ? c.grupos : gsesEscolhidas();

      if (!continuando) {
        c.itens = [];
        c.marcados.clear();
        c.descartados = 0;
        c.lidos = 0;
        c.proximoSkip = 0;
        c.total = 0;
        c.erro = '';
        c.buscou = false;
        c.resultados = [];
        c.grupos = grupos;
      }
      c.buscando = true;
      render();

      try {
        // Conta antes de buscar, e so na primeira pagina: e uma requisicao de 1
        // registro que diz o tamanho do resultado, e com ela a tela nunca mostra
        // "20 globais" quando existem 800.
        if (!continuando) {
          setStatus('Contando quantos globais batem com o filtro…');
          const cont = await PgApi.contarBusca({ desde, situacao: c.situacao, grupos });
          c.total = cont.total;
          c.filtro = cont.filtro;
          if (!c.total) {
            c.buscou = true;
            setStatus('O SMAX não encontrou nenhum global com esse filtro.', 'err');
            return;
          }
        }

        setStatus(`Trazendo ${Math.min(PgApi.PAGINA_BUSCA, c.total - c.lidos)} de ${c.total}…`);
        const pag = await PgApi.buscarPagina({ desde, situacao: c.situacao, grupos, skip: c.proximoSkip });
        c.filtro = pag.filtro;
        // O total da pagina vale mais que o da contagem: foi medido agora.
        c.total = pag.total;
        c.itens = c.itens.concat(pag.itens);
        c.descartados += pag.descartados;
        c.lidos += pag.lidos;
        c.proximoSkip = pag.proximoSkip;
        c.buscou = true;

        // Pagina que volta vazia com total maior e um laco infinito em potencial
        // no botao "carregar mais". Trava aqui, dizendo o que aconteceu.
        if (!pag.lidos && c.lidos < c.total) {
          c.erro = `o SMAX diz haver ${c.total} mas parou de devolver linhas em ${c.lidos}`;
          setStatus('A paginação parou antes do total informado.', 'err');
          return;
        }

        const novos = c.itens.filter(x => !Dados.acharGlobal(x.id)).length;
        setStatus(
          `${c.lidos} de ${c.total} lido(s) — ${novos} ainda não está(ão) no painel.`,
          novos ? 'ok' : ''
        );
      } catch (err) {
        c.buscou = true;
        c.erro = PgApi.motivoDeErro(err);
        if (err && err.filtro) c.filtro = err.filtro;
        setStatus(`A consulta falhou: ${c.erro}`, 'err');
      } finally {
        c.buscando = false;
        render();
      }
    };

    const limparConsulta = () => {
      const c = consultaUI;
      c.itens = [];
      c.marcados.clear();
      c.descartados = 0;
      c.lidos = 0;
      c.proximoSkip = 0;
      c.total = 0;
      c.erro = '';
      c.buscou = false;
      c.resultados = [];
      c.nota = '';
      Dados.EIXOS.forEach(e => c.marcas[e.chave].clear());
      // As GSEs escolhidas NAO sao limpas: sao configuracao de quem usa, nao
      // resultado de consulta. Limpar e para a tela, nao para o filtro.
      render();
      setStatus('');
    };

    /* Confere e inclui os marcados, aqui mesmo. A conferencia e a mesma regra da
     * aba Incluir (`conferirUm`) e a escrita e o mesmo `Dados.incluir` — o que
     * muda e so de onde vem a lista de ids. */
    const consultaIncluir = async () => {
      if (consultaUI.incluindo || busy) return;
      lerNotaConsulta();
      const c = consultaUI;
      const ids = consultaMarcadosNovos();
      if (!ids.length) { setStatus('Nenhum global marcado.', 'err'); return; }

      c.incluindo = true;
      c.resultados = [];
      render();
      setStatus(`Conferindo ${ids.length} chamado(s) no SMAX antes de incluir…`);

      try {
        const conferidos = await PgApi.emLote(ids, conferirUm);
        const marcas = {
          assunto: [...c.marcas.assunto],
          base: [...c.marcas.base],
          competencia: [...c.marcas.competencia]
        };
        // O desfecho de cada id vira linha na tela: aprovado que entrou, e
        // recusado com o motivo. "Marquei 5 e entraram 3" sem dizer por que e o
        // tipo de silencio que faz desconfiar do painel inteiro.
        c.resultados = conferidos.map((x) => {
          if (x.estado !== 'ok') return x;
          const r = Dados.incluir(x.id, marcas, c.nota);
          return r.ok
            ? { id: x.id, estado: 'incluido', titulo: x.titulo }
            : { id: x.id, estado: 'erro', motivo: r.msg };
        });
        const entraram = c.resultados.filter(x => x.estado === 'incluido');
        entraram.forEach(x => c.marcados.delete(x.id));

        if (entraram.length) {
          // Zera a classificacao: herdada em silencio pela proxima leva, ela
          // marcaria global com assunto que ninguem escolheu para ele. Mesmo
          // cuidado da aba Abrir depois de criar.
          Dados.EIXOS.forEach(e => c.marcas[e.chave].clear());
          c.nota = '';
        }
        render();
        const recusados = c.resultados.length - entraram.length;
        setStatus(
          recusados
            ? `${entraram.length} incluído(s), ${recusados} não entrou(aram) — veja o motivo em “Última inclusão”.`
            : `${entraram.length} global(is) incluído(s) no painel.`,
          entraram.length ? 'ok' : 'err'
        );
      } catch (err) {
        setStatus(`Falha ao incluir: ${PgApi.motivoDeErro(err)}`, 'err');
      } finally {
        c.incluindo = false;
        render();
      }
    };

    /* A REGRA DE ADMISSAO, num lugar so: existe, esta marcado como global, nao e
     * filho de outro e ainda nao esta no painel. Duas telas incluem global (a
     * aba Incluir, por lista colada, e a aba Consultar, por marcacao) e as duas
     * chamam isto — uma segunda copia da regra seria uma copia para divergir.
     * Vale mesmo quando a consulta "ja sabe" que o chamado e global: a lista na
     * tela tem a idade da ultima consulta, e nesse intervalo o chamado pode ter
     * sido vinculado a outro global. */
    const conferirUm = async (id) => {
      // Checa o painel antes de gastar requisicao: repetido nao precisa de rede.
      if (Dados.acharGlobal(id)) return { id, estado: 'repetido' };
      try {
        const r = await PgApi.conferir(id);
        if (r.estado === 'inexistente') return { id, estado: 'inexistente' };
        if (r.paiId) return { id, estado: 'filho', motivo: `É filho do global #${r.paiId}.` };
        if (!r.ehGlobal) return { id, estado: 'nao-global', titulo: r.titulo };
        return { id, estado: 'ok', titulo: r.titulo };
      } catch (err) {
        // Leitura que falhou nao e "nao existe": estado proprio, visivel.
        return { id, estado: 'erro', motivo: `Não foi possível conferir: ${err.message}` };
      }
    };

    const conferirIds = async () => {
      if (incluirUI.verificando) return;
      const { txt, ids } = lerIdsDigitados();
      incluirUI.texto = txt;
      if (!ids.length) {
        setStatus('Nenhum número de chamado reconhecido no texto.', 'err');
        return;
      }
      incluirUI.verificando = true;
      incluirUI.resultados = [];
      render();
      setStatus(`Conferindo ${ids.length} chamado(s) no SMAX…`);
      try {
        incluirUI.resultados = await PgApi.emLote(ids, conferirUm);
        const n = incluirUI.resultados.filter(x => x.estado === 'ok').length;
        setStatus(`${n} de ${ids.length} pode(m) entrar.`, n ? 'ok' : 'err');
      } catch (err) {
        setStatus(`Falha na conferência: ${err.message}`, 'err');
      } finally {
        incluirUI.verificando = false;
        render();
      }
    };

    const incluirAprovados = () => {
      if (busy) return;
      const aprovados = incluirUI.resultados.filter(x => x.estado === 'ok');
      if (!aprovados.length) { setStatus('Nada aprovado para incluir.', 'err'); return; }
      const notaEl = overlay.querySelector('#smax-gl-nota');
      incluirUI.nota = notaEl ? notaEl.value : incluirUI.nota;
      const marcas = {
        assunto: [...incluirUI.marcas.assunto],
        base: [...incluirUI.marcas.base],
        competencia: [...incluirUI.marcas.competencia]
      };
      const falhas = [];
      let ok = 0;
      aprovados.forEach(x => {
        const r = Dados.incluir(x.id, marcas, incluirUI.nota);
        r.ok ? ok++ : falhas.push(r.msg);
      });
      incluirUI.resultados = [];
      incluirUI.texto = '';
      incluirUI.nota = '';
      // Vai para o painel: incluir e nao ver o resultado em lugar nenhum da a
      // impressao de que nada aconteceu.
      if (ok) activeTab = 'painel';
      render();
      setStatus(
        falhas.length ? `${ok} incluído(s). ${falhas.join(' ')}` : `${ok} global(is) incluído(s) no painel.`,
        falhas.length ? 'err' : 'ok'
      );
    };

    /* ---------- Sincronizacao com o GitHub ---------- */
    const salvarGit = () => {
      const urlEl = overlay.querySelector('#smax-gl-arquivo-url');
      const tokenEl = overlay.querySelector('#smax-gl-gh-token');
      const url = (urlEl ? urlEl.value : '').trim();
      if (url && !GitSync.parseRawUrl(url)) {
        setStatus('A URL deve ser https://raw.githubusercontent.com/{dono}/{repo}/{branch}/{caminho}.', 'err');
        return;
      }
      PgStore.prefs.arquivoUrl = url;
      // Campo vazio nao apaga o token salvo — senao todo render o perderia.
      const token = (tokenEl ? tokenEl.value : '').trim();
      if (token) PgStore.prefs.githubToken = token;
      PgStore.salvarPrefs();
      urlDigitada = null;
      render();
      setStatus(token ? 'URL e token salvos.' : 'URL salva.', 'ok');
    };

    const publicarGit = async () => {
      if (busy) return;
      busy = true;
      try {
        const v = await GitSync.publicar((m) => setStatus(m));
        render();
        setStatus(`Publicado — versão ${v}.`, 'ok');
      } catch (err) {
        setStatus(err.desatualizado ? err.message : `Falha ao publicar: ${err.message}`, 'err');
      } finally {
        busy = false;
      }
    };

    const importarGit = async () => {
      if (busy) return;
      busy = true;
      try {
        setStatus('Baixando o arquivo…');
        const { remotoSan, previa } = await GitSync.prepararImportacao();
        const nada = !previa.entram.length && !previa.saem.length && !previa.mudam.length
          && previa.eixos.every(e => !e.entram && !e.saem && !e.renomeados);

        const linha = (rotulo, n, extra = '') =>
          `<tr><td>${rotulo}</td><td><strong>${n}</strong>${extra}</td></tr>`;

        const corpo = `
          <div class="smax-gl-note ${nada ? 'smax-gl-note-ok' : 'smax-gl-note-warn'}">
            Arquivo na versão <strong>${previa.versaoRemota}</strong>; esta máquina na
            <strong>${previa.versaoLocal}</strong>.<br>
            ${nada
              ? 'Nada muda — o conteúdo é igual ao que já está aqui.'
              : 'Importar <strong>substitui</strong> a lista desta máquina pela do arquivo. O que está abaixo é o efeito.'}
          </div>
          <table class="smax-gl-kv">
            ${linha('Globais que entram', previa.entram.length, previa.entram.length ? ` — ${Utils.escapeHtml(previa.entram.slice(0, 8).join(', '))}${previa.entram.length > 8 ? '…' : ''}` : '')}
            ${linha('Globais que saem', previa.saem.length, previa.saem.length ? ` — ${Utils.escapeHtml(previa.saem.slice(0, 8).join(', '))}${previa.saem.length > 8 ? '…' : ''}` : '')}
            ${linha('Globais com marcação/nota diferente', previa.mudam.length)}
            ${previa.eixos.map(e => linha(
              `${e.rotulo} — valores`,
              `${e.entram} entram, ${e.saem} saem, ${e.renomeados} renomeados`
            )).join('')}
          </table>
          ${previa.saem.length ? `
            <div class="smax-gl-note smax-gl-note-warn">
              Os ${previa.saem.length} global(is) que saem existem só aqui. Se foram incluídos nesta
              máquina e ainda não publicados, importar os perde — publique antes se quiser mantê-los.
            </div>` : ''}`;

        setStatus('');
        if (!(await askModal('Importar do GitHub', corpo, nada ? 'Importar mesmo assim' : 'Importar e substituir'))) {
          setStatus('Importação cancelada.');
          return;
        }
        GitSync.aplicarImportacao(remotoSan);
        render();
        setStatus(`Importado — versão ${PgStore.dados()._version}.`, 'ok');
      } catch (err) {
        setStatus(`Falha ao importar: ${err.message}`, 'err');
      } finally {
        busy = false;
      }
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

          // Passo 4 — registrar no painel. E escrita local, nao chega ao SMAX,
          // entao nunca invalida o chamado; mas tambem nao pode ser silenciosa:
          // se falhar, quem abriu precisa saber que o global ficou fora do painel.
          let painelNote = '';
          if (form.incluirNoPainel) {
            const rIncl = Dados.incluir(newId, form.marcas, '');
            painelNote = rIncl.ok
              ? `<div class="smax-gl-note smax-gl-note-ok">Incluído no painel${
                   Dados.EIXOS.some(e => form.marcas[e.chave].size) ? ' com a classificação marcada' : ' <strong>sem classificação</strong>'
                 }.</div>`
              : `<div class="smax-gl-note smax-gl-note-err">
                   Não foi incluído no painel: ${Utils.escapeHtml(rIncl.msg)}
                   Inclua pela aba <strong>Incluir</strong>.
                 </div>`;
            if (rIncl.ok) form.marcas = { assunto: new Set(), base: new Set(), competencia: new Set() };
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
            ${painelNote}
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

    /* ---------- Redimensionar coluna ----------
     * Instante em que o ultimo arraste terminou. Existe porque soltar o mouse
     * depois de arrastar dispara `click` no cabecalho, e o cabecalho ordena: sem
     * isto, toda vez que o usuario acertasse a largura a lista reordenaria junto.
     * Olhar so o alvo do clique nao bastaria — se o mouse saiu da alca durante o
     * arraste, o alvo do `click` passa a ser o `<th>`, nao a alca. */
    let redimAte = 0;

    const larguraPadrao = () => {
      PgStore.prefs.larguras = {};
      PgStore.salvarPrefs();
      render();
      setStatus('Larguras de coluna de volta ao padrão.');
    };

    const wireRedim = () => {
      /* Evento de PONTEIRO, nao de mouse, por causa do `setPointerCapture`: com
       * captura, o `pointerup` chega na alca mesmo que o usuario solte o botao
       * fora da janela do navegador. Com `mouseup` no document isso nao vale —
       * soltar fora da janela nao entrega evento nenhum, e o painel ficaria
       * preso em modo de redimensionar (cursor de seta dupla em tudo, texto
       * sem poder selecionar) ate fechar e reabrir. */
      overlay.addEventListener('pointerdown', (ev) => {
        const alca = ev.target.closest('.smax-gl-grip');
        if (!alca || ev.button !== 0) return;
        const chave = alca.dataset.grip;
        const col = overlay.querySelector(`colgroup col[data-col="${chave}"]`);
        const th = alca.closest('th');
        if (!col || !th) return;

        /* Sem `preventDefault` aqui, de proposito. Cancelar o `pointerdown`
         * suprime os eventos de mouse compativeis que o navegador derivaria
         * dele, e o clique duplo que restaura a coluna depende justamente
         * desses. Quem impede a selecao de texto durante o arraste e o CSS
         * (`user-select:none` na alca e em tudo enquanto `data-redim` esta
         * ligado), que para isso e mais confiavel do que `preventDefault`. */
        const x0 = ev.clientX;
        // Parte da largura REAL na tela, nao da gravada: na primeira vez nao ha
        // gravada, e a largura efetiva pode ser maior do que a padrao porque a
        // tabela e `width:100%`. Usar a padrao faria a coluna pular no primeiro
        // pixel de movimento.
        const l0 = th.getBoundingClientRect().width;
        // O proprio overlay e o `.smax-gl-root` (ver `open`).
        overlay.dataset.redim = 'true';
        try { alca.setPointerCapture(ev.pointerId); } catch { /* sem captura, o arraste ainda funciona dentro da janela */ }

        const largAqui = (e) => Math.max(LARG_MIN, Math.round(l0 + (e.clientX - x0)));

        const mover = (e) => {
          const larg = largAqui(e);
          // Durante o arraste mexe no DOM e nao no estado: e um `col.style` por
          // movimento do mouse, sem re-render e sem gravar em disco a cada pixel.
          col.style.width = `${larg}px`;
          const t = col.closest('table');
          if (t) t.style.minWidth = `${somaLarguras({ [chave]: larg })}px`;
        };

        const soltar = (e) => {
          alca.removeEventListener('pointermove', mover);
          alca.removeEventListener('pointerup', soltar);
          alca.removeEventListener('pointercancel', soltar);
          delete overlay.dataset.redim;
          PgStore.prefs.larguras[chave] = largAqui(e);
          PgStore.salvarPrefs();
          const aviso = overlay.querySelector('.smax-gl-larg-aviso');
          if (aviso) aviso.dataset.ajustada = 'true';
          redimAte = Date.now();
        };

        // Na alca, e nao no document: com a captura ativa e ela que recebe tudo.
        alca.addEventListener('pointermove', mover);
        alca.addEventListener('pointerup', soltar);
        // `pointercancel` e o caso de o sistema tomar o ponteiro (gesto de toque
        // virando rolagem, por exemplo). Sem tratar, ficaria preso igual.
        alca.addEventListener('pointercancel', soltar);
      });

      // Clique duplo na alca devolve so aquela coluna ao padrao — e a saida para
      // quem arrastou demais e nao quer perder o ajuste das outras.
      overlay.addEventListener('dblclick', (ev) => {
        const alca = ev.target.closest('.smax-gl-grip');
        if (!alca) return;
        ev.preventDefault();
        delete PgStore.prefs.larguras[alca.dataset.grip];
        PgStore.salvarPrefs();
        redimAte = Date.now();
        render();
      });
    };

    /* ---------- Eventos ---------- */
    const wire = () => {
      wireRedim();
      overlay.addEventListener('click', (ev) => {
        const tab = ev.target.closest('.smax-gl-tab');
        if (tab) {
          readForm();
          // A nota da consulta tambem e campo de formulario: sair da aba sem
          // le-la perderia o que foi digitado e nao entrou em global nenhum.
          lerNotaConsulta();
          activeTab = tab.dataset.tab;
          render();
          /* Abrir a aba limpa o selo — DEPOIS do render, de proposito: assim a
             tela que o usuario acabou de ver ainda destaca o que era novo, e o
             selo nao fica aceso em cima de novidade ja lida. */
          if (activeTab === 'novidades') { PgStore.marcarNovidadesVistas(); syncLauncher(); }
          return;
        }

        const col = ev.target.closest('th[data-ordem]');
        if (col) {
          // Nao ordena se o clique foi na alca de largura, nem no clique que
          // vem logo depois de um arraste (ver `redimAte`). A janela de 300ms e
          // generosa de proposito: errar para o lado de nao ordenar e so o
          // usuario clicar de novo; errar para o outro reordena 600 linhas na
          // cara de quem so queria mexer na largura.
          if (ev.target.closest('.smax-gl-grip') || Date.now() - redimAte < 300) return;
          const chave = col.dataset.ordem;
          // Clicar na coluna que ja ordena inverte; clicar em outra troca de
          // coluna e abre na direcao natural dela, nao na que estava em uso.
          if (PgStore.prefs.ordem === chave) {
            PgStore.prefs.ordemAsc = !PgStore.prefs.ordemAsc;
          } else {
            PgStore.prefs.ordem = chave;
            PgStore.prefs.ordemAsc = Metrica.ASC_PRIMEIRO.has(chave);
          }
          PgStore.salvarPrefs();
          render();
          return;
        }

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
        else if (act === 'criar-valor') {
          const eixo = ev.target.closest('[data-eixo]').dataset.eixo;
          const input = overlay.querySelector(`#smax-gl-novo-${eixo}`);
          const r = Dados.criarValor(eixo, input ? input.value : '');
          render();
          setStatus(r.msg, r.ok ? 'ok' : 'err');
        }
        else if (act === 'renomear-valor') {
          const btn = ev.target.closest('[data-eixo]');
          const eixo = btn.dataset.eixo;
          const id = btn.dataset.id;
          const atual = Dados.nomeDe(eixo, id);
          const novo = prompt('Novo nome:', atual);
          if (novo === null) return;
          const r = Dados.renomearValor(eixo, id, novo);
          render();
          setStatus(r.msg, r.ok ? 'ok' : 'err');
        }
        else if (act === 'remover-valor') {
          const btn = ev.target.closest('[data-eixo]');
          const eixo = btn.dataset.eixo;
          const id = btn.dataset.id;
          const usos = Dados.contarUsos(eixo, id);
          const aviso = usos
            ? `Remover “${Dados.nomeDe(eixo, id)}”? Ele está marcado em ${usos} global(is) e a marcação será desfeita.`
            : `Remover “${Dados.nomeDe(eixo, id)}”?`;
          if (!confirm(aviso)) return;
          const r = Dados.removerValor(eixo, id);
          render();
          setStatus(r.msg, r.ok ? 'ok' : 'err');
        }
        else if (act === 'atualizar-smax') { atualizarDoSmax(); }
        else if (act === 'filtro-eixo') {
          const btn = ev.target.closest('[data-eixo]');
          const lista = PgStore.prefs.filtros[btn.dataset.eixo];
          const i = lista.indexOf(btn.dataset.id);
          i >= 0 ? lista.splice(i, 1) : lista.push(btn.dataset.id);
          PgStore.salvarPrefs();
          render();
        }
        // A barra do grafico de filhos leva ao chamado. Nao da para usar <a>
        // dentro de SVG com o mesmo estilo das outras barras, e o numero do
        // chamado so existe aqui como data-id.
        else if (act === 'abrir-chamado') {
          const id = ev.target.closest('[data-id]').dataset.id;
          window.open(`/saw/Request/${encodeURIComponent(id)}/general`, '_blank', 'noopener');
        }
        else if (act === 'filtro-arquivados') {
          PgStore.prefs.filtros.verArquivados = !PgStore.prefs.filtros.verArquivados;
          PgStore.salvarPrefs();
          render();
        }
        else if (act === 'limpar-filtros') {
          PgStore.prefs.filtros = { assunto: [], base: [], competencia: [], status: '', termo: '', verArquivados: false };
          PgStore.salvarPrefs();
          render();
        }
        else if (act === 'ver-global') {
          verModal(ev.target.closest('[data-id]').dataset.id);
        }
        else if (act === 'editar-global') {
          const id = ev.target.closest('[data-id]').dataset.id;
          const g = Dados.acharGlobal(id);
          if (g) editarModal(g); else setStatus(`#${id} não está no painel.`, 'err');
        }
        else if (act === 'arquivar-encerrados') { arquivarEncerrados(); }
        else if (act === 'larguras-padrao') { larguraPadrao(); }
        else if (act === 'novid-vistas') {
          PgStore.marcarNovidadesVistas();
          syncLauncher();
          render();
        }
        else if (act === 'novid-limpar') {
          if (!confirm('Apagar o histórico de novidades? As marcas d\'água da comparação não são afetadas — o monitor continua achando o que mudar daqui para frente.')) return;
          PgStore.limparNovidades();
          syncLauncher();
          render();
          setStatus('Histórico de novidades apagado.');
        }
        else if (act === 'mon-ligado') {
          const m = PgStore.prefs.monitor;
          m.ligado = !m.ligado;
          PgStore.salvarPrefs();
          // Reagenda em vez de esperar: ligar o monitor e ver "próxima sondagem
          // em ~28 min" (sobra da agenda antiga) parece que nao funcionou.
          PgMonitor.reagendar();
          render();
          setStatus(m.ligado
            ? `Monitoramento ligado — primeira sondagem em ${m.minutos} min.`
            : 'Monitoramento desligado. O “↻ Atualizar do SMAX” continua comparando.');
        }
        else if (act === 'mon-so') {
          const m = PgStore.prefs.monitor;
          if (!m.notificarSO && !temNotificacao()) {
            setStatus('O Tampermonkey não concedeu GM_notification a esta versão do script. Aceite a atualização e recarregue a página.', 'err');
            return;
          }
          m.notificarSO = !m.notificarSO;
          PgStore.salvarPrefs();
          render();
          if (m.notificarSO) {
            // Notificacao de teste na hora de ligar: e o unico jeito de o usuario
            // descobrir AGORA que o Windows esta engolindo a notificacao, em vez
            // de descobrir dentro de uma semana ao perceber que nunca chegou uma.
            notificarSO('SMAX Painel de Globais', 'Notificação de teste — se você está vendo isto, o canal funciona.');
            setStatus('Notificação de teste enviada. Se ela não apareceu, o Windows está bloqueando (Assistente de Foco).');
          } else {
            setStatus('Notificação do sistema desligada. O selo e o aviso na tela continuam.');
          }
        }
        else if (act === 'arquivar' || act === 'desarquivar') {
          const id = ev.target.closest('[data-id]').dataset.id;
          const r = Dados.arquivar(id, act === 'arquivar');
          render();
          setStatus(r.msg, r.ok ? 'ok' : 'err');
        }
        else if (act === 'remover-global') {
          const id = ev.target.closest('[data-id]').dataset.id;
          if (!confirm(`Remover #${id} do painel? Isso apaga o histórico dele. Para só tirar da tela do dia a dia, use Arquivar.`)) return;
          const r = Dados.removerGlobal(id);
          render();
          setStatus(r.msg, r.ok ? 'ok' : 'err');
        }
        /* ---- Consultar ---- */
        else if (act === 'cons-dias') {
          lerNotaConsulta();
          consultaUI.dias = Number(ev.target.closest('[data-dias]').dataset.dias);
          render();
        }
        else if (act === 'cons-situacao') {
          lerNotaConsulta();
          consultaUI.situacao = ev.target.closest('[data-sit]').dataset.sit;
          render();
        }
        else if (act === 'cons-buscar') { consultar(false); }
        else if (act === 'cons-mais') { consultar(true); }
        else if (act === 'cons-limpar') { limparConsulta(); }
        else if (act === 'cons-marcar') {
          lerNotaConsulta();
          const id = ev.target.closest('[data-id]').dataset.id;
          consultaUI.marcados.has(id) ? consultaUI.marcados.delete(id) : consultaUI.marcados.add(id);
          render();
        }
        else if (act === 'cons-marcar-visiveis') {
          lerNotaConsulta();
          // So os que ainda nao estao no painel: marcar repetido nao leva a nada
          // e inflaria a contagem do botao do rodape.
          consultaUI.itens.forEach(x => { if (!Dados.acharGlobal(x.id)) consultaUI.marcados.add(x.id); });
          render();
          setStatus(`${consultaUI.marcados.size} marcado(s).`);
        }
        else if (act === 'cons-desmarcar') {
          lerNotaConsulta();
          consultaUI.marcados.clear();
          render();
        }
        else if (act === 'cons-incluir') { consultaIncluir(); }
        /* ---- Consultar: escolha de GSE ---- */
        else if (act === 'cons-gse-abrir') {
          lerNotaConsulta();
          gseUI.open = !gseUI.open;
          if (!gseUI.open) { gseUI.term = ''; gseUI.results = []; gseUI.error = ''; }
          render();
          if (gseUI.open) {
            const q = overlay.querySelector('#smax-gl-gse-q');
            if (q) q.focus();
          }
        }
        // Alterna a GSE e MANTEM a busca aberta, com termo e resultados intactos:
        // uma consulta quase sempre quer mais de um grupo, e fechar a cada clique
        // obrigava a reabrir e redigitar o termo por GSE. `refreshGseBox` em vez
        // de `render()` porque so a caixa muda — e um render inteiro tiraria o
        // foco do campo de busca.
        else if (act === 'cons-gse-escolher') {
          lerNotaConsulta();
          const el = ev.target.closest('[data-id]');
          const id = String(el.dataset.id);
          const nome = String(el.dataset.nome || '');
          const atuais = PgStore.prefs.consultaGses;
          PgStore.prefs.consultaGses = atuais.some(g => g.id === id)
            ? atuais.filter(g => g.id !== id)
            : atuais.concat([{ id, nome }]);
          PgStore.salvarPrefs();
          refreshGseBox();
        }
        else if (act === 'cons-gse-todas') {
          lerNotaConsulta();
          const atuais = PgStore.prefs.consultaGses;
          gseUI.results.forEach((g) => {
            if (!atuais.some(x => x.id === g.id)) atuais.push({ id: g.id, nome: g.nome });
          });
          PgStore.salvarPrefs();
          refreshGseBox();
        }
        else if (act === 'cons-gse-tirar') {
          lerNotaConsulta();
          const id = String(ev.target.closest('[data-id]').dataset.id);
          PgStore.prefs.consultaGses = PgStore.prefs.consultaGses.filter(g => g.id !== id);
          PgStore.salvarPrefs();
          refreshGseBox();
        }
        else if (act === 'cons-gse-limpar') {
          lerNotaConsulta();
          PgStore.prefs.consultaGses = [];
          PgStore.salvarPrefs();
          refreshGseBox();
        }
        else if (act === 'conferir-ids') { conferirIds(); }
        else if (act === 'limpar-conferencia') {
          incluirUI.resultados = [];
          incluirUI.texto = '';
          render();
          setStatus('');
        }
        else if (act === 'chip-marca') {
          const btn = ev.target.closest('[data-eixo]');
          const dono = btn.dataset.alvo === 'abrir' ? form.marcas
            : btn.dataset.alvo === 'consulta' ? consultaUI.marcas
            : incluirUI.marcas;
          const conj = dono[btn.dataset.eixo];
          conj.has(btn.dataset.id) ? conj.delete(btn.dataset.id) : conj.add(btn.dataset.id);
          // O formulario de abrir e lido antes do redesenho, senao titulo e
          // descricao ja digitados somem ao marcar um chip. Mesma razao para a
          // nota da consulta.
          if (btn.dataset.alvo === 'abrir') readForm();
          if (btn.dataset.alvo === 'consulta') lerNotaConsulta();
          render();
        }
        else if (act === 'toggle-incluir-painel') {
          readForm();
          form.incluirNoPainel = !form.incluirNoPainel;
          render();
        }
        else if (act === 'incluir-aprovados') { incluirAprovados(); }
        else if (act === 'salvar-git') { salvarGit(); }
        else if (act === 'publicar-git') { publicarGit(); }
        else if (act === 'importar-git') { importarGit(); }
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

      // Cadastrar uma lista de valores a tapa de botao e penoso; Enter cria.
      overlay.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        const m = (ev.target.id || '').match(/^smax-gl-novo-(assunto|base|competencia)$/);
        if (!m) return;
        ev.preventDefault();
        const r = Dados.criarValor(m[1], ev.target.value);
        render();
        setStatus(r.msg, r.ok ? 'ok' : 'err');
        const campo = overlay.querySelector(`#smax-gl-novo-${m[1]}`);
        if (campo) { campo.value = r.ok ? '' : ev.target.value; campo.focus(); }
      });

      overlay.addEventListener('change', (ev) => {
        if (ev.target.id === 'smax-gl-disc-to') form.contornoTo = ev.target.value;
        if (ev.target.id === 'smax-gl-disc-purpose') form.contornoPurpose = ev.target.value;
        if (ev.target.id === 'smax-gl-f-status') {
          PgStore.prefs.filtros.status = ev.target.value;
          PgStore.salvarPrefs();
          render();
        }
        if (ev.target.dataset && ev.target.dataset.act === 'mon-minutos') {
          PgStore.prefs.monitor.minutos = Number(ev.target.value);
          PgStore.salvarPrefs();
          PgMonitor.reagendar();
          render();
          setStatus(`Sondagem a cada ${PgStore.prefs.monitor.minutos} minutos.`);
        }
      });

      overlay.addEventListener('input', (ev) => {
        if (ev.target.id === 'smax-gl-title') form.title = ev.target.value;
        if (ev.target.id === 'smax-gl-desc') form.descriptionHtml = ev.target.innerHTML;
        if (ev.target.id === 'smax-gl-contorno') form.contornoHtml = ev.target.innerHTML;
        if (ev.target.id === 'smax-gl-arquivo-url') urlDigitada = ev.target.value;
        // Marcar um chip redesenha a tela; sem isto o que foi digitado morreria.
        if (ev.target.id === 'smax-gl-ids') incluirUI.texto = ev.target.value;
        if (ev.target.id === 'smax-gl-nota') incluirUI.nota = ev.target.value;
        // Nota da consulta: guarda a cada tecla e NAO redesenha — nada na tela
        // depende dela, e redesenhar tiraria o cursor do campo.
        if (ev.target.id === 'smax-gl-cons-nota') consultaUI.nota = ev.target.value;
        if (ev.target.id === 'smax-gl-f-termo') {
          PgStore.prefs.filtros.termo = ev.target.value;
          clearTimeout(filtroDebounce);
          // Redesenhar a cada tecla tiraria o foco do campo; por isso o atraso e
          // a devolucao do cursor logo depois.
          filtroDebounce = setTimeout(() => {
            PgStore.salvarPrefs();
            render();
            const el = overlay && overlay.querySelector('#smax-gl-f-termo');
            if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
          }, 280);
        }
        if (ev.target.id === 'smax-gl-person-q') {
          personUI.term = ev.target.value;
          clearTimeout(personDebounce);
          const term = personUI.term;
          personDebounce = setTimeout(() => runPersonSearch(term), 300);
        }
        if (ev.target.id === 'smax-gl-gse-q') {
          gseUI.term = ev.target.value;
          clearTimeout(gseDebounce);
          const term = gseUI.term;
          gseDebounce = setTimeout(() => runGseSearch(term), 300);
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
              <h2>🌐 SMAX Painel de Globais</h2>
              <div class="smax-gl-sub">v${SMAX_GLOBAL_VERSION}</div>
            </div>
            <div class="smax-gl-header-actions">
              <button class="smax-gl-theme-btn" data-act="tema">🌓</button>
              <button data-act="fechar">✕</button>
            </div>
          </div>
          <div class="smax-gl-tabs">
            <button class="smax-gl-tab" data-tab="painel">Painel</button>
            <button class="smax-gl-tab" data-tab="graficos">Gráficos</button>
            <button class="smax-gl-tab" data-tab="novidades">Novidades</button>
            <button class="smax-gl-tab" data-tab="abrir">Abrir chamado</button>
            <button class="smax-gl-tab" data-tab="consultar">Consultar</button>
            <button class="smax-gl-tab" data-tab="incluir">Incluir global</button>
            <button class="smax-gl-tab" data-tab="aprender">Aprender molde</button>
            <button class="smax-gl-tab" data-tab="config">Configuração</button>
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

      // Depois do pivo a casa e o painel: toda abertura cai na lista de globais.
      // Antes caia em 'abrir'/'aprender' e o painel so aparecia se clicassem na aba.
      activeTab = abaInicial || 'painel';
      abaInicial = null;
      ThemeManager.apply(ThemeManager.current());
      render();
      if (activeTab === 'novidades') { PgStore.marcarNovidadesVistas(); syncLauncher(); }
    };

    /* Abre o painel JA numa aba. Nao da para usar o `open()` direto: ele e um
     * alterna — com o painel aberto, chamar `open()` o FECHARIA, e o usuario que
     * clicou num aviso de novidade veria o painel desaparecer. */
    const abrirEm = (aba) => {
      if (overlay) {
        activeTab = aba;
        render();
        if (aba === 'novidades') { PgStore.marcarNovidadesVistas(); syncLauncher(); }
        return;
      }
      abaInicial = aba;
      open();
    };

    const init = () => {
      if (launcher) return;
      launcher = document.createElement('button');
      launcher.id = 'smax-global-btn';
      launcher.className = 'smax-gl-root';
      launcher.textContent = '🌐';
      // Fechado numa arrow: `open` recebe argumento desde a fase 6 e passar o
      // evento de clique no lugar da aba daria uma aba chamada "[object
      // PointerEvent]" — tela em branco, sem erro no console.
      launcher.addEventListener('click', () => open());
      document.body.appendChild(launcher);

      // Selo de novidade, irmao do botao: quem avisa com o painel fechado.
      selo = document.createElement('button');
      selo.id = 'smax-global-selo';
      selo.className = 'smax-gl-root';
      selo.dataset.n = '0';
      selo.addEventListener('click', () => abrirEm('novidades'));
      document.body.appendChild(selo);

      syncLauncher();
      Capture.onChange(syncLauncher);
      PgMonitor.onNovidades(aoNovidades);
      PgMonitor.iniciar();
    };

    return { init, open, abrirEm };
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
