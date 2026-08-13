/* ============================================================================
   Nomes dos tipos de campo — uma lista, três consumidores

   Existe separado de src/config-formulario.js por uma razão de dependência: o
   db.js precisa desta lista para montar o CHECK da coluna "tipo", e não pode
   importar config-formulario (que importa o db). Um módulo pequeno, sem
   dependência nenhuma, quebra o ciclo.

   Quem lê:
     src/db.js               monta o CHECK da coluna
     src/config-formulario.js descreve cada tipo (rótulo, ajuda, config)
     views/admin-formulario   monta o seletor

   Acrescentar um tipo é acrescentar aqui e descrever em config-formulario.
   Esquecer daqui faz a gravação falhar com erro de constraint; esquecer de lá
   faz o tipo não aparecer na tela.
   ========================================================================== */

const NOMES_TIPOS_CAMPO = [
  // Genéricos, oferecidos no construtor de perguntas.
  'data',
  'selecao',
  'texto',
  'texto_longo',
  'numero',
  'anexo',
  // Com validação de negócio própria.
  'nome',
  'cpf',
  'cpf_cnpj',
  'telefone',
  'email',
  'placa',
];

module.exports = { NOMES_TIPOS_CAMPO };
