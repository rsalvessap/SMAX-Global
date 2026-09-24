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

1. **Aprender molde** (uma vez) — você ativa o modo aprender e preenche *um* chamado global
   normalmente, pela tela nativa do SMAX, **indo até marcar "É Global"**. O script intercepta os
   corpos das requisições que a própria UI do SMAX enviaria e guarda como molde.
2. **Abrir chamado** (sempre) — você preenche título, descrição e urgência. O script clona o
   molde, sobrescreve esses campos, descarta os campos de identidade do chamado antigo
   e reenvia no mesmo endpoint.

### São duas requisições, não uma

Pelo procedimento da equipe, **"É Global" é marcado depois de salvar**, na aba Classificação. Ou
seja, a criação sozinha produz um chamado comum. Por isso o aprendizado tem dois moldes:

| Molde | O que é | Sem ele |
|---|---|---|
| **molde** | o `CREATE` do chamado | não dá para abrir nada |
| **moldeGlobal** | o `UPDATE` que marcou "É Global" | o chamado nasce comum, e o painel avisa para marcar à mão |

No replay do passo 2 o script só troca o `Id` pelo do chamado recém-criado — o campo que marca
"É Global" viaja junto no molde, então não é preciso saber o nome dele.

### Molde único

O procedimento pede um global por público/oferta (1º Grau, 2º Grau, Externo), e cada um muda
solicitante e oferta — campos congelados no molde. O escopo aqui é **uma equipe só**, então um
molde basta. Para abrir de um público diferente é preciso recapturar.

### Modo seco — aprender sem abrir chamado

Aprender não deveria custar um chamado em produção. Com o **modo seco** (ligado por padrão), o
interceptador decide **antes** de a requisição sair: se o corpo serve como molde, ele é guardado
e a requisição é **cancelada** — nada chega ao servidor.

Na prática: você preenche a tela do SMAX, clica em salvar, e **o SMAX acusa erro ao salvar**.
Esse erro é a confirmação de que nada foi criado. O molde já está capturado. Para o passo 2,
marque "É Global" em um chamado comum qualquer e salve — o chamado também não é alterado.

O cancelamento é local: o XHR recebe um evento `error` (status 0) e o `fetch` rejeita com
`TypeError`, exatamente como numa queda de rede. Não dá para forjar `readyState`, então se
alguma tela ficar girando em vez de acusar erro, é só recarregar — a captura fica guardada.

Duas consequências que valem saber:

- Enquanto o modo aprender está ligado, **qualquer** save de um `Request` é cancelado, não só o
  do global. Não deixe o modo ligado enquanto trabalha normalmente.
- Abrir chamado pelo painel fica bloqueado com o modo aprender ligado — senão o script cancelaria
  a própria criação.

Se em alguma tela o modo seco não funcionar, dá para desligá-lo e aprender abrindo um chamado
de verdade (o comportamento das versões anteriores). O painel pede confirmação antes.

As capturas são marcadas com **não foi salvo** ou **salvo no SMAX**, para não restar dúvida.

O modo aprender e as capturas ficam em `GM_setValue`, não em memória: o SMAX recarrega a página
ao navegar até a tela de abertura, e um estado só em memória se perderia no meio do fluxo.

### Quando não captura nada

O painel tem um bloco **Diagnóstico** listando toda requisição que passou pelo interceptador e
**não** virou candidato, com o motivo (`URL fora de /rest/{tenant}/`, `corpo não é JSON`,
`JSON sem CREATE de Request`) e um trecho do corpo. Se o chamado foi aberto e nenhuma captura
apareceu, é ali que se vê o formato real do payload — sem precisar adivinhar a heurística.

### O que o molde carrega

| Campo | Origem |
|---|---|
| `DisplayLabel` | você digita |
| `Description` | você digita (editor rich-text) |
| `Urgency` + `ImpactScope` | preset Baixa / Média / Alta / Crítica |
| `RequestedForPerson` | vem do molde; dá para trocar no painel |
| `Id`, `CreateTime`, `LastUpdateTime`, `UpdateTime`, `Comments` | **descartados** |
| todo o resto | replicado do molde |

### Solicitado para

O molde congela o solicitante da captura, que é o caso comum. Quando for preciso abrir para
outro, o campo **Solicitado para** tem um seletor: ele já abre listando os usuários
`GLOBAL EPROC` (os válidos para global), e aceita busca livre por início de nome.

A escolha **não persiste** — ao reabrir o painel o campo volta ao padrão do molde. Trocar é
exceção; se ficasse gravado, uma troca pontual viraria o padrão silencioso da próxima abertura.

A entidade `Person` do SMAX rejeita `LIKE`/`%`, então a busca é por range de prefixo
(`Name >= 'TERMO' and Name < 'TERMP'`). O molde guarda só o `Id` do solicitante, então o nome
exibido vem de um cache `Id → Nome` em `GM_setValue` — sem ele o painel mostraria um número
a cada recarga de página.

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
node test/server.js        # http://localhost:8899/test/harness.html
```

O servidor também finge ser a API do SMAX: responde `POST /rest/{tenant}/...` com um ID novo a
cada `CREATE`. Isso permite exercitar o replay inteiro — criação **e** marcação "É Global" — sem
tocar em produção. O log do servidor mostra cada chamada, e é ali que se confirma que o `CREATE`
foi sem `Id` e que o `UPDATE` seguinte usou o ID recém-criado.

O mock também serve `GET ems/Person`, reproduzindo o range de prefixo, com quatro pessoas
`GLOBAL EPROC` e duas fora do grupo — as duas existem para provar que o filtro exclui mesmo.

Os botões do harness disparam XHR/fetch imitando o SMAX: criação, marcação "É Global" e ruído.
O botão de ruído confirma que GET e `UPDATE` de outras entidades **não** viram candidato a molde.

O harness persiste o GM storage em `localStorage` e recarrega a página sob demanda — de propósito:
com stub em memória, o bug de perder o modo aprender no reload ficava invisível.

### Convívio com os outros scripts SMAX

SMAX Respostas e SMAX Triagem rodam nas mesmas páginas e usam os mesmos nomes de token
`--sp-*` e o atributo `data-smax-theme` no `<html>`. Para não brigarem, aqui os tokens ficam
escopados em `.smax-gl-root` e o tema nunca toca `<html>`/`<body>`. O botão flutuante fica em
`bottom:60px` para não colidir com o de configurações dos outros scripts.

## Versionamento

`@version` no cabeçalho e `SMAX_GLOBAL_VERSION` no topo do IIFE precisam andar juntos.
Push no `master` publica para todos os usuários via `@downloadURL`/`@updateURL`.
