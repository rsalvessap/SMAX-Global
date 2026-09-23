# SMAX Global — TJSP

Userscript Tampermonkey que automatiza a **abertura de chamado global** no SMAX do TJSP.

Chamado global, aqui, é o chamado que a equipe abre para concentrar várias demandas idênticas.
O script não vincula os filhos — ele só abre o global e devolve o ID.

```
SMAX/SMAX Global - TJSP.user.js   # o script
test/harness.html                 # harness local de desenvolvimento
```

## Como funciona

O SMAX exige um punhado de campos para criar um `Request` (serviço, oferta, solicitante,
grupo designado, campos customizados `_c`…) e esses campos variam por instalação.
Em vez de adivinhar quais são, o script **aprende observando**:

1. **Aprender molde** (uma vez) — você ativa o modo aprender e abre *um* chamado global
   normalmente, pela tela nativa do SMAX. O script intercepta o corpo da requisição que a
   própria UI do SMAX enviou e guarda como molde.
2. **Abrir chamado** (sempre) — você preenche título, descrição e urgência. O script clona o
   molde, sobrescreve esses três campos, descarta os campos de identidade do chamado antigo
   e reenvia no mesmo endpoint.

Durante o aprendizado nada é enviado: o script apenas observa o tráfego que a tela do SMAX
já faria de qualquer jeito.

### O que o molde carrega

| Campo | Origem |
|---|---|
| `DisplayLabel` | você digita |
| `Description` | você digita (editor rich-text) |
| `Urgency` + `ImpactScope` | preset Baixa / Média / Alta / Crítica |
| `Id`, `CreateTime`, `LastUpdateTime`, `UpdateTime`, `Comments` | **descartados** |
| todo o resto | replicado do molde |

O corpo inteiro da requisição é clonado — não só `properties` — para que qualquer campo irmão
que o SMAX espere viaje junto no replay.

## Segurança

- Antes de qualquer criação, um modal mostra **o payload exato** que será enviado, com aviso
  de que é produção. Dá para copiar o JSON em vez de enviar.
- `enableRealWrites` em `GM_setValue('smax_global_prefs')` desliga as escritas reais.
- O script só roda em `suporte.tjsp.jus.br`, fora de iframes.

## Desenvolvimento

Sem build, sem dependências — o `.user.js` é o artefato final.

```bash
node --check "SMAX/SMAX Global - TJSP.user.js"
```

### Harness local

Testa o script fora do SMAX, incluindo o caminho real de captura. O harness remove o guard de
hostname só na hora de carregar; o arquivo publicado não é alterado.

```bash
node -e "const http=require('http'),fs=require('fs'),path=require('path');const t={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};http.createServer((q,s)=>{const p=path.join(__dirname,decodeURIComponent(q.url.split('?')[0]));fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);s.end('nf');return}s.writeHead(200,{'Content-Type':t[path.extname(p)]||'application/octet-stream'});s.end(d)})}).listen(8899,()=>console.log('http://localhost:8899/test/harness.html'))"
```

Os botões do harness disparam XHR/fetch imitando o SMAX criando um chamado, exercitando o
interceptador de verdade. O botão de ruído confirma que GET e `UPDATE` de outras entidades
**não** viram candidato a molde.

### Convívio com os outros scripts SMAX

SMAX Respostas e SMAX Triagem rodam nas mesmas páginas e usam os mesmos nomes de token
`--sp-*` e o atributo `data-smax-theme` no `<html>`. Para não brigarem, aqui os tokens ficam
escopados em `.smax-gl-root` e o tema nunca toca `<html>`/`<body>`. O botão flutuante fica em
`bottom:60px` para não colidir com o de configurações dos outros scripts.

## Versionamento

`@version` no cabeçalho e `SMAX_GLOBAL_VERSION` no topo do IIFE precisam andar juntos.
Push no `master` publica para todos os usuários via `@downloadURL`/`@updateURL`.
