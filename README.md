# SMAX Painel de Globais — TJSP

Userscript Tampermonkey para os **chamados globais** do SMAX do TJSP: um painel que mantém a
lista curada da equipe, **abre** global novo por molde e **acompanha** o que muda nos que já
estão abertos.

Chamado global, aqui, é o chamado que a equipe abre para concentrar várias demandas idênticas.
O script não vincula os filhos — ele só abre o global e devolve o ID.

> **Se você acabou de instalar, leia a seção [Primeiro uso](#primeiro-uso--importe-a-lista-do-administrador).**
> O painel nasce vazio de propósito: a lista de globais da equipe mora num arquivo no GitHub e
> precisa ser **importada** uma vez em cada máquina.

---

## Instalação

1. Instale a extensão **Tampermonkey** no navegador.
2. Abra o link do script e confirme a instalação:
   [SMAX Global - TJSP.user.js](https://github.com/rsalvessap/SMAX-Global/raw/refs/heads/master/SMAX/SMAX%20Global%20-%20TJSP.user.js)
3. Abra o SMAX e procure o botão flutuante **🌐** no canto inferior direito.

O script só roda em `suporte.tjsp.jus.br/saw/*` e fora de iframes — em qualquer outro site ele
nem carrega. Atualização é automática: push no `master` publica para todos via
`@downloadURL`/`@updateURL`.

O **🌐** abre e fecha o painel. Quando há novidade ainda não vista, ele ganha um selo com a
contagem; com o modo aprender ligado, o selo fica vermelho.

---

## Primeiro uso — importe a lista do administrador

**A lista de globais não vem dentro do script.** Ela mora num JSON no GitHub que o administrador
publica, e cada máquina importa de lá. Sem esse passo o painel fica assim:

> O painel está vazio. Use **Consultar** para achar os globais que já estão abertos no SMAX, ou
> **Incluir global** se você já tem os números em mãos. Em **Configuração** ficam os valores de
> assunto, base e competência.

Não comece cadastrando à mão. Importe primeiro — vem tudo junto: os globais, as marcações, as
notas e as listas de **Assunto**, **Base** e **Competência**.

### Onde ficam os controles

Painel **🌐** → aba **Configuração** → bloco **Arquivo compartilhado**.

### Importar não precisa de token

O campo da URL **já vem preenchido** com o arquivo da equipe:

```
https://raw.githubusercontent.com/rsalvessap/SMAX-TOOLS/master/painel-globais.json
```

A leitura passa pelo `raw.githubusercontent.com`, que é público. O painel mesmo avisa: *"Sem token
o painel ainda importa — só não publica"*. O campo de token logo abaixo serve **só** para
**⬆ Publicar no GitHub** — veja [Publicar de volta](#publicar-de-volta--só-quem-mantém-a-lista).

Então, na máquina nova, é só clicar em **⬇ Importar do GitHub**.

Se o administrador passou outra URL, cole no campo e clique em **Salvar URL e token** *antes* de
importar. A URL tem que ter a forma `https://raw.githubusercontent.com/{dono}/{repo}/{branch}/{caminho}`,
senão o painel recusa.

### O botão mostra a prévia antes de aplicar

**⬇ Importar do GitHub** não grava nada de imediato. Ele baixa o arquivo e abre o modal
**Importar do GitHub** com a versão do arquivo contra a desta máquina e uma tabela do efeito:

| Linha | O que conta |
|---|---|
| **Globais que entram** | estão no arquivo e não aqui — são os que você quer |
| **Globais que saem** | estão só aqui e vão desaparecer |
| **Globais com marcação/nota diferente** | mesmo ID, outra classificação ou outra nota |
| **{eixo} — valores** | assunto, base, competência: quantos entram, saem e são renomeados |

Confirmar é **Importar e substituir** — ou **Importar mesmo assim** quando nada mudaria, porque o
arquivo é igual ao que já está na máquina.

### Importar substitui, não junta

Essa é a única coisa que vale decorar. A importação troca a lista local pela do arquivo: global
incluído nesta máquina e **ainda não publicado** se perde. O modal conta quantos estão nessa
situação e avisa para publicar antes.

**Na primeira importação isso é indiferente** — não há nada a perder, a lista local está vazia.
Depois, o hábito é: importe antes de trabalhar, publique quando terminar.

### Quando a importação reclama

| Mensagem | O que fazer |
|---|---|
| `A URL deve ser https://raw.githubusercontent.com/{dono}/{repo}/{branch}/{caminho}.` | a URL foi editada e saiu do formato — recoloque a do administrador |
| `Não existe arquivo nesse caminho ainda. Publique uma vez primeiro.` | o caminho está certo mas o arquivo não existe; confirme a URL com quem mantém a lista |
| `Falha ao importar: …` | rede ou proxy barrando `raw.githubusercontent.com` |

---

## O painel, aba por aba

| Aba | Para quê |
|---|---|
| **Painel** | a lista de globais, com filtros, contagem de filhos e arquivamento |
| **Gráficos** | abertos × encerrados, filhos por global, globais por eixo e por mês |
| **Novidades** | o que mudou nos globais desde a leitura anterior |
| **Abrir chamado** | cria um global novo a partir do molde |
| **Consultar** | acha globais já abertos no SMAX sem saber o número |
| **Incluir global** | põe na lista globais cujos números você já tem |
| **Aprender molde** | ensina ao script como a sua equipe abre um global |
| **Configuração** | listas de classificação, arquivo compartilhado e monitoramento |

### Painel

A lista. Os cartões do topo resumem **na tela**, **filhos somados**, **arquivados** e
**sem leitura**. Cada linha tem **Ver** (abre o chamado no SMAX), **Editar**, **Arquivar** /
**Reabrir** e **Remover**.

No rodapé, **↻ Atualizar do SMAX** lê o estado atual de todos os globais não arquivados. É a
mesma leitura que o monitoramento faz sozinho — o botão serve para não esperar a próxima rodada.

Quando há global encerrado na tela, aparece um aviso com **Arquivar os N encerrados**. Arquivar
não perde nada: marcações, nota e contagem de filhos ficam, e os gráficos continuam contando.

Os filtros (chips de assunto, base, competência, situação, busca e arquivados) valem para o
Painel e para os Gráficos. **Limpar filtros** zera; **Restaurar padrão** devolve a largura das
colunas.

### Gráficos

Mesmos filtros do Painel, menos o de arquivados — no gráfico o arquivado entra na conta sempre.
Antes da primeira leitura, três dos quatro gráficos não têm o que mostrar e a tela manda clicar
em **↻ Atualizar do SMAX**.

### Novidades

O diário do monitoramento: filhos novos, troca de status, de fase, de GSE e de título. Abrir a
aba marca tudo como visto e limpa o selo do **🌐**. Tem **Marcar todas como vistas** e
**Limpar histórico**.

### Consultar

Para achar global já aberto **sem saber o número**. Escolha a **GSE (designação atual do
chamado)**, o período em **Aberto nos últimos** e a **Situação**, e clique em
**Conferir no SMAX**.

Nos resultados, **marcar** seleciona as linhas (ou **Marcar os N da lista**). Dá a classificação
e a **Nota (opcional)** de uma vez para os marcados, e o rodapé inclui tudo com
**Incluir os N marcados** — sem trocar de aba.

### Incluir global

Quando os números já estão em mãos. Cole na caixa separados por espaço, vírgula ou linha, clique
em **Conferir no SMAX** — o bloco **Conferência** diz quantos podem entrar — e feche com
**Incluir no painel (N)**.

### Abrir chamado

Preencha **Título do chamado**, **Descrição** (editor com negrito, itálico, listas e link),
**Urgência / impacto** (**Baixa**, **Média**, **Alta**, **Crítica**) e, se for o caso,
**Solicitado para** e a **Classificação no painel**.

O campo **Solução de contorno** é opcional: preenchido, vai como discussão no chamado; vazio, não
posta nada. **Salvar como padrão** guarda solicitante, descrição e contorno para as próximas.

No rodapé, **Ver payload** mostra o JSON exato antes de enviar e **🌐 Abrir chamado global** cria.

> **Esta aba só funciona depois de aprender o molde.** Sem molde ela mostra: *"Nenhum molde
> aprendido ainda. O script precisa ver você abrir um chamado global pela tela nativa do SMAX
> para aprender quais campos esse tipo de chamado exige."* Vá para **Aprender molde**.

### Aprender molde

O SMAX exige um punhado de campos para criar um chamado, e eles variam por instalação. Em vez de
adivinhar, o script aprende observando você abrir **um** global pela tela nativa.

São **dois** passos, porque pelo procedimento da equipe "É Global" é marcado *depois* de salvar,
na aba Classificação:

| Molde | O que é | Sem ele |
|---|---|---|
| **molde** | o `CREATE` do chamado | não dá para abrir nada |
| **moldeGlobal** (passo 2) | o `UPDATE` que marcou "É Global" | o chamado nasce comum, e o painel avisa para marcar à mão |

Com o **modo seco** ligado (o padrão, botão **Ligar modo seco (não salva)**), aprender não custa
um chamado em produção: o script guarda o corpo da requisição e **cancela** o envio.

O roteiro: clique em **⏺ Ativar modo aprender**, preencha um global normalmente pela tela do
SMAX e salve. **O SMAX vai acusar erro ao salvar — esse erro é a confirmação de que nada foi
criado.** Para o passo 2, marque "É Global" em um chamado comum qualquer e salve; ele também não
é alterado. Depois, **⏹ Parar modo aprender**.

Duas coisas para não tropeçar:

- Enquanto o modo aprender está ligado, **qualquer** save de chamado é cancelado, não só o do
  global. Não deixe ligado enquanto trabalha normalmente.
- **Abrir chamado** fica bloqueado com o modo aprender ligado — senão o script cancelaria a
  própria criação.

As capturas aparecem marcadas com **não foi salvo** ou **salvo no SMAX**, e os botões
**Usar como molde** e **Usar como passo 2 (É Global)** escolhem qual vale. Se nada for capturado,
o bloco **Diagnóstico** lista as requisições descartadas e o motivo — **Copiar diagnóstico**
manda o conteúdo para quem mantém o script.

Vale saber: o molde congela solicitante e oferta. O procedimento pede um global por público
(1º Grau, 2º Grau, Externo) — para abrir de um público diferente é preciso recapturar.

### Configuração

Além do **Arquivo compartilhado**, ficam aqui:

- **Assunto**, **Base** e **Competência** — criação livre, com **Criar**, **Renomear** e
  **Remover**. Renomear é seguro: a marcação guarda o código do valor, não o nome.
- **Monitoramento** — o chip **● Monitorando** / **○ Desligado**, o intervalo (**10**, **30** ou
  **60 minutos**) e o chip **🔔 Notifica no sistema** / **🔕 Só na página**.

A notificação do sistema é opcional porque **pode não chegar**: o Assistente de Foco do Windows a
engole sem avisar. O selo no **🌐** e o aviso na tela aparecem sempre.

---

## Publicar de volta — só quem mantém a lista

Incluiu global novo, mudou classificação ou nota? Isso está só na sua máquina até ser publicado.

**⬆ Publicar no GitHub** fica **desabilitado sem token**. Para habilitar, cole um token do GitHub
com permissão de escrita no repositório no segundo campo do bloco **Arquivo compartilhado** e
clique em **Salvar URL e token**. O token fica apenas naquele navegador e **nunca** entra no
arquivo publicado.

Publicar tem trava de versão: se outra máquina publicou depois da sua última importação, o painel
**recusa** e manda importar primeiro — em vez de apagar o que foi feito lá.

O ciclo saudável, então: **importar → trabalhar → publicar**.

---

## Segurança

- Antes de qualquer criação, um modal mostra **o payload exato** que será enviado, com aviso de
  que é produção. Dá para copiar o JSON em vez de enviar.
- O script só roda em `suporte.tjsp.jus.br`, fora de iframes.
- O token do GitHub nunca sai do navegador.

---

Quem mantém o script: as notas de implementação estão em
[docs/COMO-FUNCIONA.md](docs/COMO-FUNCIONA.md).

