# TRÁFEGO — Cadastro

Página de solicitação de cadastro com identidade visual institucional da **Jomed**.
A coleta de respostas é feita por um formulário do **Microsoft Forms** incorporado à página.

## Estrutura

| Arquivo | Descrição |
| --- | --- |
| `PAGINA.HTML` | Página principal (header, hero, formulário embutido e orientações). |
| `PAG.CSS` | Folha de estilo central — cores, espaçamentos e componentes em um só lugar. |
| `ALTERACOES_FRONTEND.md` | Notas de desenvolvimento sobre a reformulação do front-end. |

## Como usar

Basta abrir o `PAGINA.HTML` em um navegador moderno. A fonte (Inter) e os ícones
(Material Symbols) são carregados via CDN, então é necessário conexão com a internet.

> O formulário incorporado depende de autenticação no Microsoft 365 conforme as
> configurações de acesso definidas no próprio Microsoft Forms.

## Identidade visual

Baseada no portal de notícias da Jomed: azul institucional (`#005a9e`), layout
limpo e espaçado, tipografia moderna e cards bem definidos.
