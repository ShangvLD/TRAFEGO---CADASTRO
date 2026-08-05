/* ============================================================================
   Validação e normalização dos campos do cadastro

   Este módulo é PURO (não toca banco, rede nem sessão), então serve tanto para
   o servidor quanto para o navegador — e dá para testar sozinho:

     npm run testar-validacao

   Por que existe: hoje os dados chegam do Microsoft Forms sem nenhuma
   validação. Nos registros reais aparecem "Rastreador ID: ." , TAG vazia e
   placas em branco, porque o Forms aceita qualquer coisa. O formulário nativo
   valida na origem — que é barato, com a pessoa ainda olhando o documento — em
   vez de descobrir o problema depois, com o cadastro já em análise.

   Convenção de cada função:
     · normalizar*  -> devolve o valor limpo (não julga)
     · validar*     -> devolve { ok: true, valor } ou { ok: false, erro }
   ========================================================================== */

// --------------------------------------------------------------------------
// Auxiliares
// --------------------------------------------------------------------------

/** Só os dígitos de um texto. */
function apenasDigitos(txt) {
  return String(txt == null ? '' : txt).replace(/\D+/g, '');
}

/** Espaços colapsados e pontas aparadas. */
function limparTexto(txt) {
  return String(txt == null ? '' : txt)
    .replace(/\s+/g, ' ')
    .trim();
}

/** true quando o valor não tem conteúdo útil.
 *  Trata os "vazios disfarçados" que aparecem nos dados reais: ".", "-", "n/a". */
function vazio(valor) {
  const t = limparTexto(valor);
  if (!t) return true;
  return /^(\.|-|--|n\/a|na|nao|não|nenhum|sem)$/i.test(t);
}

const ok = (valor) => ({ ok: true, valor });
const erro = (mensagem) => ({ ok: false, erro: mensagem });

// --------------------------------------------------------------------------
// CPF
// --------------------------------------------------------------------------

/** Confere os dois dígitos verificadores do CPF. */
function cpfValido(cpf) {
  const d = apenasDigitos(cpf);
  if (d.length !== 11) return false;

  // 00000000000, 11111111111... têm dígito verificador correto por acidente.
  if (/^(\d)\1{10}$/.test(d)) return false;

  for (const [tamanho, posicaoDigito] of [[9, 9], [10, 10]]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) {
      soma += Number(d[i]) * (tamanho + 1 - i);
    }
    const resto = (soma * 10) % 11;
    const esperado = resto === 10 ? 0 : resto;
    if (esperado !== Number(d[posicaoDigito])) return false;
  }
  return true;
}

/** Formata como 000.000.000-00. */
function formatarCpf(cpf) {
  const d = apenasDigitos(cpf);
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function validarCpf(cpf, { obrigatorio = true } = {}) {
  if (vazio(cpf)) {
    return obrigatorio ? erro('Informe o CPF.') : ok(null);
  }
  const d = apenasDigitos(cpf);
  if (d.length !== 11) return erro('O CPF deve ter 11 dígitos.');
  if (!cpfValido(d)) return erro('CPF inválido (dígito verificador não confere).');
  return ok(d); // guardamos só os dígitos; a formatação é na exibição
}

// --------------------------------------------------------------------------
// CNPJ
// --------------------------------------------------------------------------

function cnpjValido(cnpj) {
  const d = apenasDigitos(cnpj);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;

  const calcular = (tamanho) => {
    let soma = 0;
    let peso = tamanho - 7;
    for (let i = 0; i < tamanho; i++) {
      soma += Number(d[i]) * peso;
      peso = peso - 1 < 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return calcular(12) === Number(d[12]) && calcular(13) === Number(d[13]);
}

function formatarCnpj(cnpj) {
  const d = apenasDigitos(cnpj);
  if (d.length !== 14) return d;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Aceita CPF (11) ou CNPJ (14) — o proprietário pode ser pessoa física ou jurídica. */
function validarCpfOuCnpj(valor, { obrigatorio = false } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro('Informe o CPF ou CNPJ.') : ok(null);
  }
  const d = apenasDigitos(valor);
  if (d.length === 11) {
    return cpfValido(d) ? ok(d) : erro('CPF inválido (dígito verificador não confere).');
  }
  if (d.length === 14) {
    return cnpjValido(d) ? ok(d) : erro('CNPJ inválido (dígito verificador não confere).');
  }
  return erro('Documento deve ter 11 dígitos (CPF) ou 14 (CNPJ).');
}

// --------------------------------------------------------------------------
// PIS / PASEP / NIT
//
// Onze dígitos com dígito verificador próprio: os dez primeiros são
// multiplicados pelos pesos 3,2,9,8,7,6,5,4,3,2 e o resto da divisão por 11
// define o último. Resto 0 ou 1 dá dígito 0.
//
// Só faz sentido para o proprietário PESSOA FÍSICA — empresa não tem PIS.
// --------------------------------------------------------------------------

const PESOS_PIS = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function pisValido(digitos) {
  const d = apenasDigitos(digitos);
  if (d.length !== 11) return false;
  // Todos iguais passariam na conta (00000000000 fecha), e não são PIS reais.
  if (/^(\d)\1{10}$/.test(d)) return false;

  let soma = 0;
  for (let i = 0; i < 10; i++) soma += Number(d[i]) * PESOS_PIS[i];

  const resto = soma % 11;
  const dv = resto < 2 ? 0 : 11 - resto;
  return dv === Number(d[10]);
}

/** 123.45678.90-1 */
function formatarPis(valor) {
  const d = apenasDigitos(valor);
  if (d.length !== 11) return String(valor || '');
  return `${d.slice(0, 3)}.${d.slice(3, 8)}.${d.slice(8, 10)}-${d.slice(10)}`;
}

function validarPis(valor, { obrigatorio = false } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro('Informe o PIS.') : ok(null);
  }
  const d = apenasDigitos(valor);
  if (d.length !== 11) return erro('O PIS deve ter 11 dígitos.');
  return pisValido(d) ? ok(d) : erro('PIS inválido (dígito verificador não confere).');
}

// --------------------------------------------------------------------------
// Placa de veículo
//
// Dois formatos convivem na frota brasileira:
//   · antigo:   AAA9999   (3 letras + 4 dígitos)
//   · Mercosul: AAA9A99   (3 letras, dígito, letra, 2 dígitos)
// --------------------------------------------------------------------------

const PLACA_ANTIGA = /^[A-Z]{3}\d{4}$/;
const PLACA_MERCOSUL = /^[A-Z]{3}\d[A-Z]\d{2}$/;

/** Maiúsculas, sem hífen nem espaço. */
function normalizarPlaca(placa) {
  return String(placa == null ? '' : placa)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function placaValida(placa) {
  const p = normalizarPlaca(placa);
  return PLACA_ANTIGA.test(p) || PLACA_MERCOSUL.test(p);
}

function validarPlaca(placa, { obrigatorio = false, rotulo = 'A placa' } = {}) {
  if (vazio(placa)) {
    return obrigatorio ? erro(`${rotulo} é obrigatória.`) : ok(null);
  }
  const p = normalizarPlaca(placa);
  if (p.length !== 7) {
    return erro(`${rotulo} deve ter 7 caracteres (ex.: ABC1234 ou ABC1D23).`);
  }
  if (!placaValida(p)) {
    return erro(`${rotulo} está em formato inválido (use ABC1234 ou ABC1D23).`);
  }
  return ok(p);
}

/** Formata para exibição: ABC-1234 (antiga) ou ABC1D23 (Mercosul, sem hífen). */
function formatarPlaca(placa) {
  const p = normalizarPlaca(placa);
  if (PLACA_ANTIGA.test(p)) return `${p.slice(0, 3)}-${p.slice(3)}`;
  return p;
}

// --------------------------------------------------------------------------
// E-mail
// --------------------------------------------------------------------------

// Deliberadamente simples: validação de e-mail por expressão regular nunca é
// completa. O que importa é pegar erro de digitação óbvio; a confirmação real
// vem do e-mail chegando ou não.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function validarEmail(email, { obrigatorio = true } = {}) {
  if (vazio(email)) {
    return obrigatorio ? erro('Informe o e-mail.') : ok(null);
  }
  const e = limparTexto(email).toLowerCase();
  if (!EMAIL.test(e)) return erro('E-mail em formato inválido.');
  if (e.length > 254) return erro('E-mail muito longo.');
  return ok(e);
}

// --------------------------------------------------------------------------
// Telefone (Brasil)
// --------------------------------------------------------------------------

function validarTelefone(tel, { obrigatorio = false, rotulo = 'O telefone' } = {}) {
  if (vazio(tel)) {
    return obrigatorio ? erro(`${rotulo} é obrigatório.`) : ok(null);
  }
  let d = apenasDigitos(tel);

  // Tolera o código do país colado pelo WhatsApp (55 + DDD + número).
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);

  if (d.length !== 10 && d.length !== 11) {
    return erro(`${rotulo} deve ter DDD + número (10 ou 11 dígitos).`);
  }
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return erro(`${rotulo} tem DDD inválido.`);

  // Celular (11 dígitos) começa com 9 depois do DDD.
  if (d.length === 11 && d[2] !== '9') {
    return erro(`${rotulo}: celular com 11 dígitos deve começar com 9 após o DDD.`);
  }
  return ok(d);
}

function formatarTelefone(tel) {
  const d = apenasDigitos(tel);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

// --------------------------------------------------------------------------
// Datas
//
// Guardamos sempre em "AAAA-MM-DD" (ordena como texto e o front já entende).
// Aceita entrada em AAAA-MM-DD (input type=date) ou DD/MM/AAAA (digitado).
// --------------------------------------------------------------------------

function normalizarData(valor) {
  const t = limparTexto(valor);
  if (!t) return null;

  let ano, mes, dia;

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const br = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (iso) [, ano, mes, dia] = iso;
  else if (br) [, dia, mes, ano] = br;
  else return null;

  ano = Number(ano);
  mes = Number(mes);
  dia = Number(dia);

  if (mes < 1 || mes > 12) return null;

  // Confere o dia dentro do mês (inclusive fevereiro em ano bissexto).
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  if (dia < 1 || dia > ultimoDia) return null;

  const mm = String(mes).padStart(2, '0');
  const dd = String(dia).padStart(2, '0');
  return `${ano}-${mm}-${dd}`;
}

/**
 * @param opcoes.futura  true  = precisa estar no futuro (validade de documento)
 * @param opcoes.passada true  = precisa estar no passado (nascimento)
 * @param opcoes.hoje    data de referência "AAAA-MM-DD" (para o teste ser determinístico)
 */
function validarData(valor, { obrigatorio = false, rotulo = 'A data', futura = false, passada = false, hoje = null } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro(`${rotulo} é obrigatória.`) : ok(null);
  }
  const d = normalizarData(valor);
  if (!d) return erro(`${rotulo} é inválida (use DD/MM/AAAA).`);

  const referencia = hoje || new Date().toISOString().slice(0, 10);

  if (futura && d <= referencia) {
    return erro(`${rotulo} já está vencida.`);
  }
  if (passada && d >= referencia) {
    return erro(`${rotulo} deve ser uma data passada.`);
  }
  return ok(d);
}

/** Dias entre hoje e a data (negativo = já passou). */
function diasAte(data, hoje = null) {
  const d = normalizarData(data);
  if (!d) return null;
  const referencia = hoje || new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${d}T00:00:00Z`) - Date.parse(`${referencia}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

// --------------------------------------------------------------------------
// CNH
// --------------------------------------------------------------------------

const CATEGORIAS_CNH = ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'];

function validarCnhNumero(valor, { obrigatorio = false } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro('Informe o número da CNH.') : ok(null);
  }
  const d = apenasDigitos(valor);
  if (d.length !== 11) return erro('O número da CNH deve ter 11 dígitos.');
  return ok(d);
}

function validarCategoriaCnh(valor, { obrigatorio = false } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro('Informe a categoria da CNH.') : ok(null);
  }
  const c = limparTexto(valor).toUpperCase();
  if (!CATEGORIAS_CNH.includes(c)) {
    return erro(`Categoria inválida. Use uma de: ${CATEGORIAS_CNH.join(', ')}.`);
  }
  return ok(c);
}

// --------------------------------------------------------------------------
// Texto livre (nome, observação, TAG, id de rastreador)
// --------------------------------------------------------------------------

function validarTexto(valor, { obrigatorio = false, rotulo = 'O campo', min = 0, max = 500 } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro(`${rotulo} é obrigatório.`) : ok(null);
  }
  const t = limparTexto(valor);
  if (t.length < min) return erro(`${rotulo} deve ter pelo menos ${min} caracteres.`);
  if (t.length > max) return erro(`${rotulo} deve ter no máximo ${max} caracteres.`);
  return ok(t);
}

function validarNome(valor, { obrigatorio = true, rotulo = 'O nome' } = {}) {
  const r = validarTexto(valor, { obrigatorio, rotulo, min: 3, max: 120 });
  if (!r.ok || r.valor == null) return r;
  if (!r.valor.includes(' ')) {
    return erro(`${rotulo} deve ser o nome completo (nome e sobrenome).`);
  }
  if (!/[A-Za-zÀ-ÿ]/.test(r.valor)) {
    return erro(`${rotulo} deve conter letras.`);
  }
  return r;
}

// --------------------------------------------------------------------------
// Operações / clientes
//
// Hoje o "assunto" da solicitação concatena as operações com "|" — e os
// registros reais vêm com separadores vazios ("MERCADO LIVRE | SHOPEE | | | |").
// Aqui a lista é explícita, sem vazios e sem repetição.
// --------------------------------------------------------------------------

// As NOVE operações do formulário "CADASTRO TERCEIRO 2.0", na mesma ordem e com
// a mesma grafia das perguntas ("OPERAÇÃO 1" a "OPERAÇÃO 9").
//
// Nos 51 registros históricos só apareceram MERCADO LIVRE, SHOPEE, AMAZON e
// JOMED — os outros cinco existem no formulário mas ainda não tiveram cadastro
// (contratação de terceiro é rara nesses clientes, não impossível).
const OPERACOES = [
  'MERCADO LIVRE',
  'SHOPEE',
  'AMAZON',
  'SAMSUNG',
  'BAYER',
  'LOREAL',
  'KENVUE',
  'KENVUE ANGEL',
  'JOMED',
];

// ---------------------------------------------------------------------------
// Rastreamento: quem fornece a TAG de pedágio e quem fornece o rastreador
//
// Listas fechadas em vez de texto livre. Antes, cada pessoa digitava do seu
// jeito ("SEM PARA", "Sem Parar", "semparar") e agrupar por fornecedor virava
// adivinhação. A lista resolve na entrada, que é o único lugar barato.
//
// Para incluir um fornecedor novo, acrescente aqui: o formulário, a validação
// e o servidor leem desta mesma lista.
// ---------------------------------------------------------------------------

const TAGS_PEDAGIO = ['CONECT CAR', 'SEM PARAR', 'VELOE'];

const RASTREADORES = ['SASCAR', 'AUTOTRAC', 'ONIXSAT', 'OMNILINK'];

/**
 * Valida um valor contra uma lista fechada.
 *
 * Tolerante na comparação (sem acento, sem espaço duplicado, maiúsculas) e
 * exato na gravação: o que entra no banco é o valor da lista, não o que a
 * pessoa digitou. É isso que faz o agrupamento por fornecedor funcionar.
 */
function validarDaLista(valor, lista, { rotulo = 'O valor', obrigatorio = false } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro(`${rotulo} é obrigatório.`) : ok(null);
  }

  const chave = (t) =>
    String(t)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();

  const alvo = chave(valor);
  const achado = lista.find((item) => chave(item) === alvo);
  if (achado) return ok(achado);

  return erro(`${rotulo} deve ser um destes: ${lista.join(', ')}.`);
}

// ---------------------------------------------------------------------------
// Grau de importância do cadastro
//
// Quem envia sabe se o motorista vai carregar em seguida; a fila de
// atendimento não tem como adivinhar. O campo é OBRIGATÓRIO de propósito: com
// um padrão silencioso, todo mundo deixa no padrão e a informação some.
//
// A ordem do array É a ordem da fila — o primeiro é o mais urgente.
// ---------------------------------------------------------------------------

const PRIORIDADES = [
  { id: 'imediato', rotulo: 'Vai carregar em instantes', cor: 'vermelho', bolinha: '🔴', ordem: 0,
    ajuda: 'Prioridade máxima: o motorista tem carregamento iminente.' },
  { id: 'urgente', rotulo: 'Urgente', cor: 'amarelo', bolinha: '🟡', ordem: 1,
    ajuda: 'Cadastro prioritário, à frente da fila normal.' },
  { id: 'pode_aguardar', rotulo: 'Pode aguardar', cor: 'verde', bolinha: '🟢', ordem: 2,
    ajuda: 'Sem urgência: segue a fila normal.' },
];

function acharPrioridade(id) {
  return PRIORIDADES.find((p) => p.id === String(id || '').trim().toLowerCase()) || null;
}

/** Posição na fila. Cadastro antigo, sem o campo, entra como "pode aguardar". */
function ordemDaPrioridade(id) {
  const p = acharPrioridade(id);
  return p ? p.ordem : PRIORIDADES.length;
}

function validarPrioridade(valor, { obrigatorio = true } = {}) {
  if (vazio(valor)) {
    return obrigatorio ? erro('Informe o grau de importância do cadastro.') : ok(null);
  }
  const p = acharPrioridade(valor);
  return p ? ok(p.id) : erro('Grau de importância inválido.');
}

// ---------------------------------------------------------------------------
// Tipos de documento
//
// Extraídos das perguntas de upload REAIS do Microsoft Forms (o nome da
// pergunta virava o nome da pasta no SharePoint, e os 200 anexos revelam a
// lista). Duas perguntas eram DUPLICADAS e foram unificadas:
//
//   · "ANTT 1"  -> nunca apareceu sem "ANTT" (0 de 4 casos). Pergunta repetida.
//   · "Certificado ( SEST SENAT ) - Curso - Direção Segura" -> nunca apareceu
//     sem "DIREÇÃO SEGURA - MERCADO LIVRE" (0 de 9). Mesmo documento, dois
//     rótulos. Unificados em CERT_DIRECAO_SEGURA.
//
// "ocorrencias" é a contagem nos 51 registros — serve para ordenar por
// relevância e indicar o que é praticamente sempre exigido.
//
// "operacoes" limita o documento a certas operações (null = vale para todas).
// O curso SEST SENAT / Direção Segura só é exigido por MERCADO LIVRE, SHOPEE e
// AMAZON — regra confirmada nos dados: dos 51 registros, NENHUM anexou esse
// certificado sem ter uma dessas três operações.
// ---------------------------------------------------------------------------
const TIPOS_DOCUMENTO = [
  { id: 'CNH',                   rotulo: 'CNH do condutor',                  ocorrencias: 41, temValidade: true,  operacoes: null },
  { id: 'CRLV_CAVALO',           rotulo: 'CRLV do cavalo',                   ocorrencias: 30, temValidade: true,  operacoes: null },
  { id: 'COMPROVANTE_RESIDENCIA',rotulo: 'Comprovante de residência',        ocorrencias: 27, temValidade: false, operacoes: null },
  { id: 'CRLV_CARRETA',          rotulo: 'CRLV da carreta',                  ocorrencias: 26, temValidade: true,  operacoes: null },
  { id: 'FOTO_CONDUTOR_CNH',     rotulo: 'Foto do condutor segurando a CNH', ocorrencias: 22, temValidade: false, operacoes: null },
  { id: 'ANTT',                  rotulo: 'ANTT',                             ocorrencias: 20, temValidade: true,  operacoes: null },
  {
    id: 'CERT_DIRECAO_SEGURA',
    rotulo: 'Certificado de Direção Segura (SEST SENAT)',
    ocorrencias: 19,
    temValidade: true,
    operacoes: ['MERCADO LIVRE', 'SHOPEE', 'AMAZON'],
  },
];

/** Procura um tipo de documento pelo id. */
function acharTipoDocumento(id) {
  const alvo = String(id || '').toUpperCase();
  return TIPOS_DOCUMENTO.find((t) => t.id === alvo) || null;
}

/**
 * Documentos que se aplicam às operações escolhidas.
 *
 * Sem operação nenhuma marcada, devolve só os que valem para todas — evita
 * mostrar exigência de um cliente que a pessoa ainda não selecionou.
 *
 * Observação: nos dados históricos, 30 registros têm operação que pede o
 * certificado e não o anexaram. Ou seja, na prática ele é EXIGIDO mas não
 * bloqueante — por isso esta função apenas indica o que se aplica; não recusa
 * o cadastro por falta de documento.
 */
function documentosPara(operacoes) {
  const marcadas = (Array.isArray(operacoes) ? operacoes : [operacoes])
    .filter((o) => !vazio(o))
    .map((o) => limparTexto(o).toUpperCase());

  return TIPOS_DOCUMENTO.filter(
    (t) => !t.operacoes || t.operacoes.some((op) => marcadas.includes(op))
  );
}

function validarOperacoes(lista, { permitidas = OPERACOES } = {}) {
  const entrada = Array.isArray(lista) ? lista : [lista];
  const vistas = new Set();
  const saida = [];

  for (const item of entrada) {
    if (vazio(item)) continue;
    const nome = limparTexto(item).toUpperCase();
    if (!permitidas.includes(nome)) {
      return erro(`Operação desconhecida: "${nome}".`);
    }
    if (vistas.has(nome)) continue;
    vistas.add(nome);
    saida.push(nome);
  }

  if (saida.length === 0) {
    return erro('Selecione pelo menos uma operação.');
  }
  return ok(saida);
}

// --------------------------------------------------------------------------
// Validação do cadastro completo
//
// Devolve { ok, dados, erros } — "erros" é um objeto campo -> mensagem, para o
// front destacar cada campo em vez de mostrar um alerta genérico.
// --------------------------------------------------------------------------

/**
 * @param opcoes.hoje                 data de referência (deixa o teste determinístico)
 * @param opcoes.operacoesPermitidas  lista vinda da CONFIGURAÇÃO do banco
 *   (cfg_operacoes). Sem ela, cai na constante OPERACOES — que é só a semente.
 *   Isso importa: se o admin cadastrar um cliente novo pela tela, a validação
 *   precisa aceitá-lo sem alteração de código.
 */
function validarCadastro(entrada, { hoje = null, operacoesPermitidas = null } = {}) {
  const e = entrada || {};
  const erros = {};
  const dados = {};

  const aplicar = (campo, resultado) => {
    if (resultado.ok) dados[campo] = resultado.valor;
    else erros[campo] = resultado.erro;
  };

  // Condutor
  aplicar('condutor_nome', validarNome(e.condutor_nome, { rotulo: 'O nome do condutor' }));
  aplicar('condutor_cpf', validarCpf(e.condutor_cpf));
  aplicar('condutor_email', validarEmail(e.condutor_email, { obrigatorio: false }));
  aplicar('condutor_telefone', validarTelefone(e.condutor_telefone, { obrigatorio: true, rotulo: 'O contato do condutor' }));
  aplicar('cnh_numero', validarCnhNumero(e.cnh_numero));
  aplicar('cnh_categoria', validarCategoriaCnh(e.cnh_categoria));
  aplicar('cnh_validade', validarData(e.cnh_validade, { rotulo: 'A validade da CNH', futura: true, hoje }));

  // Proprietário
  aplicar('proprietario_nome', validarTexto(e.proprietario_nome, { rotulo: 'O nome do proprietário', max: 120 }));
  aplicar('proprietario_documento', validarCpfOuCnpj(e.proprietario_documento));
  aplicar('proprietario_telefone', validarTelefone(e.proprietario_telefone, { rotulo: 'O contato do proprietário' }));
  aplicar('proprietario_pis', validarPis(e.proprietario_pis));

  // O PIS é de pessoa física. Preenchido junto com um CNPJ, alguém digitou no
  // campo errado — e um número no campo errado é pior que campo vazio, porque
  // parece dado bom.
  if (
    !erros.proprietario_pis &&
    !vazio(e.proprietario_pis) &&
    apenasDigitos(e.proprietario_documento).length === 14
  ) {
    erros.proprietario_pis = 'PIS é do proprietário pessoa física. Com CNPJ, deixe em branco.';
  }

  // Veículo
  aplicar('placa_cavalo', validarPlaca(e.placa_cavalo, { rotulo: 'A placa do cavalo' }));
  aplicar('placa_carreta', validarPlaca(e.placa_carreta, { rotulo: 'A placa da carreta' }));

  // Rastreamento
  aplicar('tag', validarDaLista(e.tag, TAGS_PEDAGIO, { rotulo: 'A TAG' }));
  aplicar('rastreador', validarDaLista(e.rastreador, RASTREADORES, { rotulo: 'O rastreador' }));
  aplicar('rastreador_id', validarTexto(e.rastreador_id, { rotulo: 'O ID do rastreador', max: 60 }));

  // Prioridade
  aplicar('prioridade', validarPrioridade(e.prioridade, { obrigatorio: true }));

  // Observação
  aplicar('obs', validarTexto(e.obs, { rotulo: 'A observação', max: 2000 }));

  // Operações
  aplicar(
    'operacoes',
    validarOperacoes(e.operacoes, {
      permitidas: Array.isArray(operacoesPermitidas) && operacoesPermitidas.length
        ? operacoesPermitidas.map((o) => limparTexto(o).toUpperCase())
        : OPERACOES,
    })
  );

  // Regra de negócio: é preciso ao menos uma placa. Um cadastro sem nenhum
  // veículo não tem o que ser aprovado pela GR.
  if (!erros.placa_cavalo && !erros.placa_carreta && !dados.placa_cavalo && !dados.placa_carreta) {
    erros.placa_cavalo = 'Informe ao menos uma placa (cavalo ou carreta).';
  }

  // Regra de negócio: as duas placas não podem ser a mesma.
  if (dados.placa_cavalo && dados.placa_carreta && dados.placa_cavalo === dados.placa_carreta) {
    erros.placa_carreta = 'A carreta não pode ter a mesma placa do cavalo.';
  }

  return { ok: Object.keys(erros).length === 0, dados, erros };
}

module.exports = {
  // auxiliares
  apenasDigitos,
  limparTexto,
  vazio,
  // documentos
  cpfValido,
  formatarCpf,
  validarCpf,
  cnpjValido,
  formatarCnpj,
  validarCpfOuCnpj,
  pisValido,
  formatarPis,
  validarPis,
  // listas fechadas
  PRIORIDADES,
  acharPrioridade,
  ordemDaPrioridade,
  validarPrioridade,
  TAGS_PEDAGIO,
  RASTREADORES,
  validarDaLista,
  // veículo
  normalizarPlaca,
  placaValida,
  validarPlaca,
  formatarPlaca,
  // contato
  validarEmail,
  validarTelefone,
  formatarTelefone,
  // datas
  normalizarData,
  validarData,
  diasAte,
  // CNH
  CATEGORIAS_CNH,
  validarCnhNumero,
  validarCategoriaCnh,
  // texto
  validarTexto,
  validarNome,
  // operações
  OPERACOES,
  validarOperacoes,
  // documentos
  TIPOS_DOCUMENTO,
  acharTipoDocumento,
  // completo
  validarCadastro,
};
