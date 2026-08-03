/* ============================================================================
   Campos dos formulários de cada módulo — especificação declarativa

   Em vez de um HTML e um validador por módulo, cada formulário é DESCRITO aqui
   e o resto é derivado:

     · a tela genérica desenha os campos a partir desta lista;
     · o servidor valida a partir da MESMA lista;
     · acrescentar campo é editar esta lista — não há HTML nem validação a
       escrever nos dois lados (e portanto não há como divergirem).

   O módulo TERCEIRO não está aqui: ele tem formulário próprio
   (views/cadastro.html) e validação específica em src/validacao.js, com regras
   que não se generalizam (placas iguais, ao menos uma placa, decisão por
   operação). Migrá-lo para esta especificação é possível, mas mexeria no único
   formulário já validado.

   TIPOS DE CAMPO disponíveis:
     nome      nome completo (exige nome e sobrenome)
     cpf       CPF com dígito verificador
     cpf_cnpj  CPF ou CNPJ
     telefone  DDD + número, tolera o +55
     email     e-mail
     placa     placa antiga (ABC1234) ou Mercosul (ABC1D23)
     texto     texto livre
     selecao   uma opção de uma lista fixa
   ========================================================================== */

const v = require('./validacao');

// ---------------------------------------------------------------------------
// AGREGADO
// ---------------------------------------------------------------------------
const CAMPOS_AGREGADO = [
  {
    secao: 'Condutor',
    icone: 'person',
    campos: [
      { id: 'condutor_nome', rotulo: 'Nome do condutor', tipo: 'nome', obrigatorio: true, largura: 'larga' },
      { id: 'condutor_cpf', rotulo: 'CPF do condutor', tipo: 'cpf', obrigatorio: true, dica: 'Conferido pelo dígito verificador' },
      { id: 'condutor_telefone', rotulo: 'Número do condutor', tipo: 'telefone', obrigatorio: true },
      { id: 'condutor_email', rotulo: 'E-mail do condutor', tipo: 'email', obrigatorio: true, largura: 'larga' },
    ],
  },
  {
    secao: 'Proprietário',
    icone: 'handshake',
    campos: [
      {
        id: 'proprietario_nome',
        rotulo: 'Nome do proprietário',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'larga',
        max: 120,
        dica: 'Exatamente como consta na ANTT',
        placeholder: 'Igual ao registro na ANTT',
      },
      {
        id: 'conta_pambank',
        rotulo: 'Conta PamBank',
        tipo: 'texto',
        obrigatorio: false,
        max: 60,
        placeholder: 'Opcional',
      },
    ],
  },
  {
    secao: 'Veículo',
    icone: 'local_shipping',
    campos: [
      { id: 'placa_cavalo', rotulo: 'Placa do cavalo', tipo: 'placa', obrigatorio: true },
      { id: 'placa_carreta', rotulo: 'Placa da carreta', tipo: 'placa', obrigatorio: false, dica: 'Deixe em branco se não houver' },
    ],
  },
];

// ---------------------------------------------------------------------------
// CANDIDATO
// ---------------------------------------------------------------------------
const CAMPOS_CANDIDATO = [
  {
    secao: 'Dados do candidato',
    icone: 'person',
    campos: [
      { id: 'condutor_nome', rotulo: 'Nome do condutor', tipo: 'nome', obrigatorio: true, largura: 'larga' },
      { id: 'cpf', rotulo: 'CPF', tipo: 'cpf', obrigatorio: true, dica: 'Conferido pelo dígito verificador' },
      { id: 'telefone', rotulo: 'Número de telefone', tipo: 'telefone', obrigatorio: true },
      { id: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true, largura: 'larga' },
    ],
  },
  {
    secao: 'Perfil',
    icone: 'local_shipping',
    campos: [
      {
        id: 'tipo_motorista',
        rotulo: 'Tipo de motorista',
        tipo: 'selecao',
        obrigatorio: true,
        opcoes: ['TRUCK', 'TOCO', 'CAVALO'],
      },
      {
        id: 'localidade',
        rotulo: 'Localidade',
        tipo: 'texto',
        obrigatorio: true,
        max: 120,
        placeholder: 'Cidade / região onde atua',
      },
    ],
  },
];

const CAMPOS_POR_MODULO = {
  agregado: CAMPOS_AGREGADO,
  candidato: CAMPOS_CANDIDATO,
};

/** Todas as seções de um módulo (vazio se o módulo tiver formulário próprio). */
function secoesDe(slug) {
  return CAMPOS_POR_MODULO[String(slug || '').toLowerCase()] || [];
}

/** Lista plana dos campos de um módulo. */
function camposDe(slug) {
  return secoesDe(slug).flatMap((s) => s.campos);
}

// ---------------------------------------------------------------------------
// Validação guiada pela especificação
// ---------------------------------------------------------------------------

/** Valida um campo conforme o seu tipo. Devolve { ok, valor } ou { ok:false, erro }. */
function validarCampo(campo, valor) {
  const obrigatorio = !!campo.obrigatorio;
  const rotulo = campo.rotulo;

  switch (campo.tipo) {
    case 'nome':
      return v.validarNome(valor, { obrigatorio, rotulo: `O campo "${rotulo}"` });

    case 'cpf':
      return v.validarCpf(valor, { obrigatorio });

    case 'cpf_cnpj':
      return v.validarCpfOuCnpj(valor, { obrigatorio });

    case 'telefone':
      return v.validarTelefone(valor, { obrigatorio, rotulo: `O campo "${rotulo}"` });

    case 'email':
      return v.validarEmail(valor, { obrigatorio });

    case 'placa':
      return v.validarPlaca(valor, { obrigatorio, rotulo: `A ${rotulo.toLowerCase()}` });

    case 'selecao': {
      if (v.vazio(valor)) {
        return obrigatorio ? { ok: false, erro: `Selecione ${rotulo.toLowerCase()}.` } : { ok: true, valor: null };
      }
      const escolhido = v.limparTexto(valor).toUpperCase();
      const permitidas = (campo.opcoes || []).map((o) => String(o).toUpperCase());
      return permitidas.includes(escolhido)
        ? { ok: true, valor: escolhido }
        : { ok: false, erro: `Opção inválida. Use uma de: ${permitidas.join(', ')}.` };
    }

    case 'texto':
    default:
      return v.validarTexto(valor, {
        obrigatorio,
        rotulo: `O campo "${rotulo}"`,
        max: campo.max || 500,
      });
  }
}

/**
 * Valida uma entrada contra uma LISTA de campos.
 *
 * Recebe a lista em vez de ler a constante porque a especificação real vive no
 * banco (tabela cfg_campos, editável em /admin/formulario) — as constantes
 * deste arquivo são só a semente inicial. Se lesse daqui, uma pergunta criada
 * pela tela seria ignorada na validação.
 *
 * @returns { ok, dados, erros }
 *   dados — valores já normalizados (CPF só com dígitos, placa em maiúsculas...)
 *   erros — { idDoCampo: mensagem }, para a tela destacar cada campo
 */
function validarCampos(lista, entrada) {
  const e = entrada || {};
  const dados = {};
  const erros = {};

  for (const campo of lista || []) {
    const r = validarCampo(campo, e[campo.id]);
    if (r.ok) dados[campo.id] = r.valor;
    else erros[campo.id] = r.erro;
  }

  return { ok: Object.keys(erros).length === 0, dados, erros };
}

/** Achata as seções em uma lista de campos. */
function camposDasSecoes(secoes) {
  return (secoes || []).flatMap((s) => s.campos || []);
}

/** Valida contra as SEÇÕES vindas do banco. */
function validarSecoes(secoes, entrada) {
  return validarCampos(camposDasSecoes(secoes), entrada);
}

/** Valida usando a semente do código (uso em teste e como reserva). */
function validarModulo(slug, entrada) {
  return validarCampos(camposDe(slug), entrada);
}

/**
 * Monta o resumo que aparece na lista do painel, a partir dos dados validados.
 * Cada módulo tem o seu — o painel mostra uma linha por solicitação e precisa
 * de algo identificável ali.
 */
function resumoDe(slug, dados) {
  const d = dados || {};
  switch (String(slug || '').toLowerCase()) {
    case 'agregado': {
      const partes = [d.condutor_nome, d.placa_cavalo && v.formatarPlaca(d.placa_cavalo)];
      return partes.filter(Boolean).join(' — ') || 'Cadastro de agregado';
    }
    case 'candidato': {
      const partes = [d.condutor_nome, d.tipo_motorista, d.localidade];
      return partes.filter(Boolean).join(' — ') || 'Cadastro de candidato';
    }
    default:
      return 'Solicitação';
  }
}

/**
 * Texto de "detalhes" no mesmo formato "Rótulo: valor | ..." que o painel já
 * sabe exibir campo a campo (o modal do módulo terceiro faz isso). Reaproveitar
 * o formato evita escrever um leitor de detalhes por módulo.
 */
function detalhesDeCampos(lista, dados) {
  const d = dados || {};
  const partes = [];

  for (const campo of lista || []) {
    let valor = d[campo.id];
    if (valor == null || valor === '') continue;

    if (campo.tipo === 'cpf') valor = v.formatarCpf(valor);
    else if (campo.tipo === 'cpf_cnpj') valor = String(valor).length === 11 ? v.formatarCpf(valor) : valor;
    else if (campo.tipo === 'telefone') valor = v.formatarTelefone(valor);
    else if (campo.tipo === 'placa') valor = v.formatarPlaca(valor);

    partes.push(`${campo.rotulo}: ${valor}`);
  }

  return partes.join(' | ');
}

/** Mesma coisa, a partir das seções vindas do banco. */
function detalhesDeSecoes(secoes, dados) {
  return detalhesDeCampos(camposDasSecoes(secoes), dados);
}

/** Versão que lê a semente do código (uso em teste). */
function detalhesDe(slug, dados) {
  return detalhesDeCampos(camposDe(slug), dados);
}

module.exports = {
  CAMPOS_POR_MODULO,
  secoesDe,
  camposDe,
  validarCampo,
  validarCampos,
  validarSecoes,
  validarModulo,
  camposDasSecoes,
  resumoDe,
  detalhesDeCampos,
  detalhesDeSecoes,
  detalhesDe,
};
