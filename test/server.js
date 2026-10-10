// Servidor do harness: serve os arquivos e finge ser a API do SMAX.
// Precisa responder POST para dar pra exercitar o replay de verdade — criacao
// e marcacao "E Global" — sem tocar em producao.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8899;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

let nextId = 4567890;

// Pessoas fake. Os quatro "GLOBAL EPROC" existem para exercitar o seed do picker;
// os outros dois so provam que a busca por prefixo filtra mesmo.
/* GSEs fake (entidade `PersonGroup`). O filtro de GSE da aba Consultar e por
 * **Id**, nao por nome — por isso cada grupo aqui tem Id proprio. Antes da v1.17
 * todas as fixtures compartilhavam o Id '44444', e com isso qualquer filtro de
 * GSE pareceria funcionar: um unico Id casava com todo mundo.
 *
 * Tres coisas estao plantadas de proposito:
 *  - `SUPORTE TELEFONIA` nao e o grupo de nenhum global: escolhe-la tem de dar
 *    "nenhum global nesse filtro", e nao lista cheia.
 *  - `SUPORTE DESATIVADO` esta inativo, para provar que o recorte de Status na
 *    busca de GSE funciona (ela nao pode aparecer nos achados).
 *  - duas comecam com "SUPORTE C": prova que a busca e por INICIO de palavra e
 *    volta mais de uma. */
const GROUPS = [
  { Id: '44001', Name: 'SUPORTE EPROC',      Status: 'Active' },
  { Id: '44002', Name: 'SUPORTE CUSTAS',     Status: 'Active' },
  { Id: '44003', Name: 'SUPORTE MIGRACAO',   Status: 'Active' },
  { Id: '44004', Name: 'ATENDIMENTO',        Status: 'Active' },
  { Id: '44005', Name: 'SUPORTE CADASTRO',   Status: 'Active' },
  { Id: '44006', Name: 'SUPORTE TELEFONIA',  Status: 'Active' },
  { Id: '44007', Name: 'GSE SGS EPROC 1 GRAU', Status: 'Active' },
  { Id: '44008', Name: 'SUPORTE DESATIVADO', Status: 'Inactive' },
];
const idDoGrupo = (nome) => (GROUPS.find(g => g.Name === nome) || {}).Id || '';

const PEOPLE = [
  { Id: '51000001', Name: 'GLOBAL EPROC 1 GRAU E COLEGIO RECURSAL', Upn: 'global.eproc1@tjsp.jus.br' },
  { Id: '51000002', Name: 'GLOBAL EPROC 2 GRAU',                    Upn: 'global.eproc2@tjsp.jus.br' },
  { Id: '51000003', Name: 'GLOBAL EPROC ENTIDADE CONVENIADA',       Upn: 'global.eproc3@tjsp.jus.br' },
  { Id: '51000004', Name: 'GLOBAL EPROC PUBLICO EXTERNO',           Upn: 'global.eproc4@tjsp.jus.br' },
  { Id: '11111',    Name: 'FULANO DE TAL',                          Upn: 'fulano@tjsp.jus.br' },
  { Id: '22222',    Name: 'BELTRANO DA SILVA',                      Upn: 'beltrano@tjsp.jus.br' },
];

// Chamados fake. Os dois primeiros sao globais de verdade; o resto existe para
// forcar cada desfecho possivel da conferencia e da leitura em lote.
//   pai = valor de GlobalId_c. `relOnly` manda o campo so em related_properties,
//   que e como o SMAX devolve em parte dos casos.
const ID_ERRO_LEITURA = '82170044';   // responde 500 sempre
const ID_TETO = '82190066';           // faz a consulta em lote ser recusada pelo teto

const REQUESTS = [
  // As datas de CreateTime dos globais sao de meses DIFERENTES e de proposito
  // deixam junho e setembro de 2026 vazios: e assim que se ve se o grafico de
  // abertura por mes desenha o mes sem nenhum global em vez de pular.
  // `espec` diferente de `grupo`: e o caso que o aviso de divergencia da aba
  // Consultar existe para mostrar. Se a GSE do global desta instalacao morar em
  // ExpertGroup e nao em AssignedToGroup, e esta linha que denuncia.
  { Id: '82133910', IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — eproc 1o grau fora do ar', Status: 'InProgress', StatusSCCDSMAX_c: 'EmAtendimento_c', grupo: 'SUPORTE EPROC', espec: 'GSE SGS EPROC 1 GRAU', CreateTime: 1778770800000, LastUpdateTime: 1758900000000 },
  // GlobalId_c apontando para si mesmo, e so em related_properties: o SMAX faz
  // isso em global de verdade, e nem a conferencia nem a contagem podem ler como filho.
  { Id: '82140011', IsGlobal_c: true, DisplayLabel: 'GLOBAL — custas indevidas', Status: 'Ready', StatusSCCDSMAX_c: 'Aguardando3Nivel_c', grupo: 'SUPORTE CUSTAS', CreateTime: 1783004400000, LastUpdateTime: 1758910000000, pai: '82140011', relOnly: true },
  // Global encerrado, para a barra de "encerrados" nao ficar sempre em zero.
  // Status 'RequestStatusComplete' com o prefixo do enum, que e como o SMAX
  // devolve — os outros estao sem prefixo de proposito, para exercitar os dois.
  { Id: '82133911', IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — mandados em lote (encerrado)', Status: 'RequestStatusComplete', StatusSCCDSMAX_c: 'Fechado_c', grupo: 'SUPORTE EPROC', CreateTime: 1764774000000, LastUpdateTime: 1758915000000 },
  { Id: '82150022', IsGlobal_c: 'false', DisplayLabel: 'Chamado comum de usuario', Status: 'Ready', grupo: 'ATENDIMENTO', CreateTime: 1757200000000, LastUpdateTime: 1758920000000 },
  { Id: '82160033', IsGlobal_c: 'false', DisplayLabel: 'Filho do global', Status: 'Ready', grupo: 'ATENDIMENTO', CreateTime: 1757300000000, LastUpdateTime: 1758930000000, pai: '82133910', relOnly: true },
  // Mais filhos, para a contagem dar numero diferente por pai (3 e 1).
  { Id: '82160034', IsGlobal_c: 'false', DisplayLabel: 'Filho 2', Status: 'Ready', grupo: 'ATENDIMENTO', pai: '82133910' },
  { Id: '82160035', IsGlobal_c: 'false', DisplayLabel: 'Filho 3', Status: 'Ready', grupo: 'ATENDIMENTO', pai: '82133910', relOnly: true },
  { Id: '82160036', IsGlobal_c: 'false', DisplayLabel: 'Filho de outro global', Status: 'Ready', grupo: 'ATENDIMENTO', pai: '82140011' },
  // Marcado no painel mas desmarcado no SMAX: o painel tem de avisar.
  { Id: '82200077', IsGlobal_c: 'false', DisplayLabel: 'Era global e alguem desmarcou', Status: 'Complete', StatusSCCDSMAX_c: 'Fechado_c', grupo: 'SUPORTE EPROC', CreateTime: 1757400000000, LastUpdateTime: 1758940000000 },
  // Global valido na leitura individual (da para incluir), mas qualquer consulta
  // em lote que o cite e recusada pelo teto de 10.000 — e assim que se testa o
  // bloco que fica sem leitura no painel.
  { Id: ID_TETO, IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — consulta estoura o teto', Status: 'InProgress', grupo: 'SUPORTE EPROC', CreateTime: 1790866800000, LastUpdateTime: 1758960000000 }
];

// Um global com 600 filhos: passa da pagina de 250 do script e por isso exercita
// o laco de paginacao. Sem ele, um lote truncado passaria batido no teste.
const ID_MUITOS = '82210088';
REQUESTS.push({ Id: ID_MUITOS, IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — migracao de base (muitos filhos)', Status: 'InProgress', StatusSCCDSMAX_c: 'EmAtendimento_c', grupo: 'SUPORTE MIGRACAO', CreateTime: 1787151600000, LastUpdateTime: 1758950000000 });
for (let i = 0; i < 600; i++) {
  REQUESTS.push({
    Id: String(83000000 + i), IsGlobal_c: 'false', DisplayLabel: `Filho em massa ${i + 1}`,
    Status: 'Ready', grupo: 'ATENDIMENTO', pai: ID_MUITOS, relOnly: i % 2 === 0
  });
}

/* Acervo sintetico de globais para a aba "Consultar" (v1.16).
 *
 * 320 globais espalhados por ~400 dias, contados a partir de AGORA — o filtro de
 * periodo compara com `Date.now()`, e fixture de data fixa deixaria de responder
 * ao recorte depois de alguns meses.
 *
 * Tres coisas estao plantadas aqui de proposito:
 *  - 320 passa dos 250 de uma pagina: a janela de 12 meses pega ~290 e por isso
 *    exercita o "carregar mais". Com 30 fixtures a paginacao nunca apareceria.
 *  - um a cada 10 e marcado "E Global" E tem GlobalId_c de outro global. Existe
 *    em producao e o filtro do servidor nao consegue tirar: e o caso que prova o
 *    descarte no cliente. O pai deles e um global proprio (`ID_PAI_SINT`), e nao
 *    o 82133910: pendurar 32 filhos no 82133910 mudaria a contagem de 3 que os
 *    testes do painel e do monitor usam como referencia.
 *  - o status cicla entre vivos e encerrados, para o chip de situacao mudar
 *    numero de forma visivel em vez de mudar nada.
 */
const AGORA = Date.now();
const DIA = 86400000;
const ID_PAI_SINT = '84999999';
const STATUS_CICLO = ['New', 'Ready', 'InProgress', 'Pending', 'Suspended',
  'RequestStatusComplete', 'Rejected', 'Cancelled'];
REQUESTS.push({
  Id: ID_PAI_SINT, IsGlobal_c: 'true', DisplayLabel: 'GLOBAL — pai dos sinteticos vinculados',
  Status: 'InProgress', StatusSCCDSMAX_c: 'EmAtendimento_c', grupo: 'SUPORTE EPROC',
  CreateTime: AGORA - 2 * DIA, LastUpdateTime: AGORA - DIA
});
for (let i = 0; i < 320; i++) {
  const filho = i % 10 === 9;
  REQUESTS.push({
    Id: String(84000000 + i),
    IsGlobal_c: i % 3 === 0 ? true : 'true',   // booleano e string, as duas formas
    DisplayLabel: `GLOBAL sintetico ${i + 1} — ${filho ? 'vinculado a outro global' : 'indisponibilidade de sistema'}`,
    Status: STATUS_CICLO[i % STATUS_CICLO.length],
    StatusSCCDSMAX_c: i % 2 ? 'EmAtendimento_c' : 'Aguardando3Nivel_c',
    grupo: ['SUPORTE EPROC', 'SUPORTE CUSTAS', 'SUPORTE MIGRACAO'][i % 3],
    // Alguns com grupo especialista divergente, espalhados: o aviso tem de
    // aparecer so nessas linhas, e nao em todas nem em nenhuma.
    espec: i % 37 === 4 ? 'GSE SGS EPROC 1 GRAU' : undefined,
    CreateTime: AGORA - Math.round(i * 1.25 * DIA),
    LastUpdateTime: AGORA - Math.round(i * 1.25 * DIA) + 3600000,
    pai: filho ? ID_PAI_SINT : undefined,
    relOnly: i % 2 === 0
  });
}

const entidadeDe = (r) => {
  const props = {
    Id: r.Id, DisplayLabel: r.DisplayLabel, IsGlobal_c: r.IsGlobal_c,
    Status: r.Status || '', StatusSCCDSMAX_c: r.StatusSCCDSMAX_c || '',
    PhaseId: r.PhaseId || '', AssignedToGroup: idDoGrupo(r.grupo),
    ExpertGroup: idDoGrupo(r.espec),
    CreateTime: r.CreateTime || 0, LastUpdateTime: r.LastUpdateTime || 0
  };
  const rel = {};
  if (r.grupo) rel.AssignedToGroup = { Id: idDoGrupo(r.grupo), Name: r.grupo };
  // `espec` so existe nas fixtures que DIVERGEM da designacao atual — e a linha
  // da aba Consultar so mostra o grupo especialista nesse caso.
  if (r.espec) rel.ExpertGroup = { Id: idDoGrupo(r.espec), Name: r.espec };
  if (r.pai) {
    if (r.relOnly) rel.GlobalId_c = { Id: r.pai };
    else props.GlobalId_c = { Id: r.pai };
  }
  return { entity_type: 'Request', properties: props, related_properties: rel };
};

// Reproduz o range de prefixo que o script usa (o SMAX nao aceita LIKE em Person).
const queryPeople = (filter) => {
  const byId = /Id\s*=\s*'([^']*)'/.exec(filter || '');
  if (byId) return PEOPLE.filter(p => p.Id === byId[1]);
  const range = /Name\s*>=\s*'([^']*)'\s+and\s+Name\s*<\s*'([^']*)'/.exec(filter || '');
  if (!range) return PEOPLE;
  return PEOPLE.filter(p => p.Name >= range[1] && p.Name < range[2]);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
});

// GitHub falso. Guarda UM arquivo em memoria e responde como a Contents API:
// GET devolve { sha, content } em base64, PUT exige o sha quando o arquivo ja
// existe. E o suficiente para exercitar a trava otimista por _version sem tocar
// num repositorio de verdade.
let ghFile = null;   // { sha, content }  content = texto, nao base64

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Lido pela importacao (equivale ao raw.githubusercontent.com)
  if (url === '/gh/raw') {
    if (!ghFile) { res.writeHead(404); res.end('not found'); return; }
    console.log('[gh] GET raw');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(ghFile.content);
    return;
  }

  // Lido e gravado pela publicacao (equivale a api.github.com/.../contents/...)
  if (url === '/gh/contents') {
    if (req.method === 'GET') {
      if (!ghFile) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"message":"Not Found"}'); return; }
      console.log('[gh] GET contents');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sha: ghFile.sha, content: Buffer.from(ghFile.content, 'utf8').toString('base64') }));
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const content = Buffer.from(String(body?.content || ''), 'base64').toString('utf8');
      if (ghFile && body?.sha !== ghFile.sha) {
        console.log('[gh] PUT recusado — sha divergente');
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"message":"sha does not match"}');
        return;
      }
      ghFile = { sha: 'sha' + Date.now(), content };
      let v = '?';
      try { v = JSON.parse(content)._version; } catch { }
      console.log(`[gh] PUT aceito — _version=${v}, ${content.length} chars`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: { sha: ghFile.sha } }));
      return;
    }
  }

  // Atalhos do harness para forcar os cenarios de borda da fase 1.
  if (url === '/gh/zerar') {
    ghFile = null;
    console.log('[gh] arquivo apagado');
    res.writeHead(200); res.end('ok');
    return;
  }
  if (url === '/gh/bumpversion') {
    if (!ghFile) { res.writeHead(404); res.end('sem arquivo'); return; }
    const obj = JSON.parse(ghFile.content);
    obj._version = (Number(obj._version) || 0) + 5;
    ghFile = { sha: 'sha' + Date.now(), content: JSON.stringify(obj, null, 2) };
    console.log(`[gh] _version forcada para ${obj._version}`);
    res.writeHead(200); res.end(String(obj._version));
    return;
  }

  // Leitura de um Request so, usada pela conferencia da tela "Incluir global".
  // Cada fixture existe para forcar um dos estados possiveis; o 500 esta aqui de
  // proposito, porque falha de leitura tem de aparecer diferente de "nao existe".
  const umRequest = /^\/rest\/\d+\/ems\/Request\/(\d+)$/i.exec(url);
  if (umRequest && req.method === 'GET') {
    const id = umRequest[1];
    console.log(`[mock] GET ems/Request/${id}`);
    if (id === ID_ERRO_LEITURA) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"meta":{"completion_status":"FAILED"}}'); return; }
    const reg = REQUESTS.find(r => r.Id === id);
    if (!reg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"meta":{"completion_status":"FAILED"},"error":{"message":"not found"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meta: { completion_status: 'OK' }, entities: [entidadeDe(reg)] }));
    return;
  }

  /* Endpoint do visualizador — o que a tela nativa do chamado usa. A forma da
   * resposta e diferente dos outros: os campos vem em `EntityData.properties`,
   * e `Comments` e uma STRING com JSON dentro. Ambas as armadilhas estao
   * reproduzidas aqui de proposito, senao o mock validaria um codigo que falha
   * em producao.
   *
   * Cada fixture forca um caso:
   *  - 82133910: HTML normal, com imagem larga e tabela (testa o CSS de conteudo
   *    de terceiro), comentario interno + publico, e um comentario de sistema
   *    que o script tem de esconder.
   *  - 82140011: descricao DUPLAMENTE escapada, que e o caso em que renderizar
   *    direto mostra as tags como texto.
   *  - 82210088: tentativa de XSS na descricao, em tres formas. Nenhuma pode
   *    executar nem sobrar no HTML renderizado.
   *  - 82133911: encerrado, com solucao preenchida.
   *  - 82220099: resposta na FORMA ERRADA (sem EntityData), para exercitar a
   *    mensagem de "formato inesperado" em vez de um modal vazio.
   *  - ID_ERRO_LEITURA: 500. */
  const FORM_FIXTURES = {
    '82133910': {
      Description: '<p>O <b>eproc de 1º grau</b> está fora do ar desde as 08h.</p>'
        + '<p><img src="/img/print-gigante.png" width="2400" alt="print"></p>'
        + '<table><tr><th>Base</th><th>Afetados</th></tr><tr><td>SP</td><td>muitos</td></tr></table>',
      Solution: '',
      Comments: JSON.stringify({ Comment: [
        { Submitter: 'Person/10001', IsSystem: false, CommentBody: '<p>Acionado o 3º nível.</p>', CreateTime: 1758900100000, PrivacyType: 'AGENTPUBLIC' },
        { Submitter: 'Person/10002', IsSystem: false, CommentBody: '<p>Fornecedor confirmou falha no storage. <b>Não repassar ao solicitante.</b></p>', CreateTime: 1758900200000, PrivacyType: 'INTERNAL' },
        { Submitter: 'Person/0', IsSystem: true, CommentBody: 'Status alterado de Pronto para Em andamento', CreateTime: 1758900050000, PrivacyType: 'AGENTPUBLIC' }
      ] })
    },
    '82140011': {
      Description: '&lt;p&gt;Custas &lt;b&gt;indevidas&lt;/b&gt; sendo cobradas em 2ª instância.&lt;/p&gt;',
      Solution: '',
      Comments: ''
    },
    '82210088': {
      Description: '<p>Migração travada.</p>'
        + '<script>window.__XSS_SCRIPT = true;</script>'
        + '<img src="x" onerror="window.__XSS_ONERROR = true">'
        + '<a href="javascript:window.__XSS_HREF=true">clique</a>',
      Solution: '',
      // JSON invalido de proposito: a discussao tem de falhar sozinha, sem
      // derrubar descricao e solucao.
      Comments: '{"Comment":[{"CommentBody":'
    },
    '82133911': {
      Description: '<p>Mandados em lote não eram gerados.</p>',
      Solution: '<p>Reprocessada a fila. <i>Validado com a unidade.</i></p>',
      Comments: JSON.stringify({ Comment: [
        { Submitter: 'Person/10001', IsSystem: false, CommentBody: '<p>Encerrando.</p>', CreateTime: 1758915000000, PrivacyType: 'AGENTPUBLIC' }
      ] })
    }
  };

  const umForm = /^\/rest\/\d+\/entity-page\/initializationDataByLayout\/Request\/(\d+)$/i.exec(url);
  if (umForm && req.method === 'GET') {
    const id = umForm[1];
    console.log(`[mock] GET entity-page/.../Request/${id}`);
    if (id === ID_ERRO_LEITURA) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"meta":{"completion_status":"FAILED"}}'); return; }
    // Antes do 404 de proposito: aqui o chamado responde 200, o problema e a
    // FORMA da resposta — e isso tem de ser distinguivel de "nao existe".
    if (id === '82220099') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"meta":{"completion_status":"OK"},"OutraCoisa":{}}');
      return;
    }
    const reg = REQUESTS.find(r => r.Id === id);
    if (!reg) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"not found"}}'); return; }
    const ent = entidadeDe(reg);
    const extra = FORM_FIXTURES[id] || { Description: '', Solution: '', Comments: '' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK' },
      EntityData: {
        properties: { ...ent.properties, ...extra },
        related_properties: ent.related_properties
      }
    }));
    return;
  }

  // Consulta em lote: estado dos globais (filter por Id) e contagem de filhos
  // (filter por GlobalId_c). Honra skip/size para exercitar a paginacao — sem
  // ela um lote truncado viraria um numero menor exibido como se fosse fato.
  if (/^\/rest\/\d+\/ems\/Request$/i.test(url) && req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const filter = qs.get('filter') || '';
    const size = Math.max(1, Number(qs.get('size')) || 100);
    const skip = Math.max(0, Number(qs.get('skip')) || 0);

    // Atalho do harness: se a cadeia contem o id de teto, responde como o SMAX
    // responde ao passar de 10.000 entidades.
    if (filter.includes(ID_TETO)) {
      console.log('[mock] GET ems/Request → recusado por teto de 10.000');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meta: { completion_status: 'FAILED' }, error: { messageKey: 'query.num.of.entities.exceeded', message: 'too many' } }));
      return;
    }
    if (filter.includes(ID_ERRO_LEITURA)) {
      console.log('[mock] GET ems/Request → 500 proposital');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"meta":{"completion_status":"FAILED"}}');
      return;
    }

    const valores = (campo) => {
      const re = new RegExp(`${campo}\\s*=\\s*'([^']*)'`, 'g');
      const out = [];
      let m;
      while ((m = re.exec(filter))) out.push(m[1]);
      return out;
    };
    // "GlobalId_c" nao casa com o padrao de "Id" porque depois de Id vem "_c".
    const porId = valores('Id');
    const porPai = valores('GlobalId_c');

    /* A consulta da aba "Consultar" (v1.16): filtro por IsGlobal_c, janela de
     * CreateTime e lista de Status. O periodo "sem recorte" responde com a
     * recusa por teto de 10.000 — e o que o SMAX faz com consulta aberta demais,
     * e e o unico jeito de exercitar esse caminho na tela. */
    if (/IsGlobal_c\s*=\s*'/.test(filter)) {
      const gses = valores('AssignedToGroup');
      /* O teto de 10.000 e por tamanho do conjunto varrido, nao pelo periodo:
       * recortar por GSE encolhe a varredura e por isso "sem recorte" de data
       * passa a ser consulta viavel. Sem essa distincao o mock ensinaria o
       * contrario do que a tela promete ao escolher uma GSE. */
      if (!/CreateTime\s*>=/.test(filter) && !gses.length) {
        console.log('[mock] GET ems/Request (busca) sem recorte de data nem de GSE → recusado por teto de 10.000');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ meta: { completion_status: 'FAILED' }, error: { messageKey: 'query.num.of.entities.exceeded', message: 'too many' } }));
        return;
      }
      const mDesde = /CreateTime\s*>=\s*(\d+)/.exec(filter);
      const desde = mDesde ? Number(mDesde[1]) : 0;
      // Os dois lados normalizados: o filtro manda sempre com o prefixo do enum,
      // e as fixtures guardam das duas formas de proposito.
      const semPref = (s) => String(s || '').replace(/^RequestStatus/, '');
      const sts = valores('Status').map(semPref);
      const ehTrue = (v) => v === true || v === 'true';
      let achados = REQUESTS.filter(r => ehTrue(r.IsGlobal_c)
        && (r.CreateTime || 0) >= desde
        && (!sts.length || sts.includes(semPref(r.Status)))
        // Por Id, como o script manda. Comparar por nome aqui esconderia o erro
        // de mandar nome no lugar de Id.
        && (!gses.length || gses.includes(idDoGrupo(r.grupo))));
      // `order` e servidor, nao cliente: se o mock nao ordenar, "mais recentes
      // primeiro" na tela seria so a ordem em que as fixtures foram declaradas.
      if (/CreateTime\s+desc/i.test(qs.get('order') || '')) {
        achados = achados.slice().sort((a, b) => (b.CreateTime || 0) - (a.CreateTime || 0));
      }
      const pag = achados.slice(skip, skip + size);
      // O filtro cru, e nao so o que o mock conseguiu entender: a precedencia de
      // and/or nos filtros do SMAX nao e documentada, e um `or` solto fora dos
      // parenteses passaria por aqui parecendo certo.
      console.log(`[mock]   filtro cru: ${filter}`);
      console.log(`[mock] GET ems/Request (busca) desde=${desde ? new Date(desde).toISOString().slice(0, 10) : 'sempre'} gses=${gses.length ? gses.join(',') : 'todas'} status=${sts.length || 'todos'} order=${qs.get('order') || '—'} skip=${skip} size=${size} → ${pag.length}/${achados.length}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        meta: { completion_status: 'OK', total_count: achados.length },
        entities: pag.map(entidadeDe)
      }));
      return;
    }

    let hits = [];
    if (porPai.length) hits = REQUESTS.filter(r => r.pai && porPai.includes(r.pai));
    else if (porId.length) hits = REQUESTS.filter(r => porId.includes(r.Id));

    const pagina = hits.slice(skip, skip + size);
    console.log(`[mock] GET ems/Request ids=${porId.length} pais=${porPai.length} skip=${skip} size=${size} → ${pagina.length}/${hits.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK', total_count: hits.length },
      entities: pagina.map(entidadeDe)
    }));
    return;
  }

  /* Busca de GSE. Entidade `PersonGroup` de proposito: `Group` responde
   * "operacao nao permitida" no SMAX de verdade. O operador e `wordstartswith`,
   * que casa com o inicio de QUALQUER palavra do nome — nao so a primeira — e e
   * por isso que o mock quebra o nome em palavras antes de comparar. Fingir
   * "startsWith" no nome inteiro faria o mock aceitar uma busca que em producao
   * volta vazia. */
  if (/^\/rest\/\d+\/ems\/PersonGroup$/i.test(url) && req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const filter = qs.get('filter') || '';
    const size = Math.max(1, Number(qs.get('size')) || 30);
    const termos = [...filter.matchAll(/Name\s+wordstartswith\s*\(\s*'([^']*)'\s*\)/gi)]
      .map(m => m[1].replace(/''/g, "'").toLocaleUpperCase('pt-BR'))
      .filter(Boolean);
    // O script manda as palavras com `and`: todas tem de casar, cada uma com
    // alguma palavra do nome.
    const soAtivos = /Status\s*=\s*'Active'/i.test(filter);
    let hits = GROUPS.filter((g) => {
      if (soAtivos && g.Status !== 'Active') return false;
      if (!termos.length) return false;
      const palavras = g.Name.toLocaleUpperCase('pt-BR').split(/\s+/);
      return termos.every(t => palavras.some(p => p.startsWith(t)));
    });
    hits = hits.slice().sort((a, b) => a.Name.localeCompare(b.Name, 'pt-BR')).slice(0, size);
    console.log(`[mock] GET ems/PersonGroup termos=${JSON.stringify(termos)} ativos=${soAtivos} → ${hits.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK', total_count: hits.length },
      entities: hits.map(g => ({ entity_type: 'PersonGroup', properties: { Id: g.Id, Name: g.Name, Status: g.Status } }))
    }));
    return;
  }

  if (/^\/rest\/\d+\/ems\/Person$/i.test(url)) {
    const filter = new URL(req.url, 'http://x').searchParams.get('filter') || '';
    const hits = queryPeople(filter);
    console.log(`[mock] GET ems/Person filter=${filter} → ${hits.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK', total_count: hits.length },
      entities: hits.map(p => ({ entity_type: 'Person', properties: p }))
    }));
    return;
  }

  if (/^\/rest\/\d+\//.test(url)) {
    const body = await readBody(req);
    const op = String(body?.operation || '').toUpperCase();
    const props = body?.entities?.[0]?.properties || {};
    console.log(`[mock] ${req.method} ${url} op=${op} Id=${props.Id ?? '(novo)'}`);

    const id = op === 'CREATE' ? String(nextId++) : String(props.Id || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      meta: { completion_status: 'OK' },
      entity_result_list: [{
        entity: { entity_type: 'Request', properties: { Id: id } },
        completion_status: 'OK'
      }]
    }));
    return;
  }

  const file = path.join(ROOT, decodeURIComponent(url));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}/test/harness.html`));
