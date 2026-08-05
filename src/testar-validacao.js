/* ============================================================================
   Testes da validação do cadastro.

     npm run testar-validacao

   Não precisa de banco nem de servidor — o módulo de validação é puro.
   Os casos foram tirados dos dados REAIS de produção (inclusive os problemáticos,
   como "Rastreador ID: ." e TAG vazia), para garantir que o formulário nativo
   rejeite o que o Microsoft Forms aceitava.
   ========================================================================== */

const v = require('./validacao');

let passou = 0;
let falhou = 0;
const falhas = [];

function conferir(descricao, condicao, detalhe = '') {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    falhas.push(`${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

/** Espera que a validação aceite, e opcionalmente que devolva um valor. */
function aceita(descricao, resultado, valorEsperado = undefined) {
  if (!resultado.ok) {
    return conferir(descricao, false, `rejeitou: ${resultado.erro}`);
  }
  if (valorEsperado !== undefined && resultado.valor !== valorEsperado) {
    return conferir(descricao, false, `devolveu ${JSON.stringify(resultado.valor)}, esperado ${JSON.stringify(valorEsperado)}`);
  }
  conferir(descricao, true);
}

/** Espera que a validação rejeite. */
function rejeita(descricao, resultado) {
  conferir(descricao, !resultado.ok, resultado.ok ? `aceitou ${JSON.stringify(resultado.valor)}` : '');
}

const HOJE = '2026-07-29'; // data fixa: o teste não pode depender do dia em que roda

// --------------------------------------------------------------------------
console.log('\n=== CPF ===');
// CPFs válidos gerados para teste (dígito verificador correto)
aceita('CPF válido com pontuação', v.validarCpf('529.982.247-25'), '52998224725');
aceita('CPF válido sem pontuação', v.validarCpf('52998224725'), '52998224725');
aceita('CPF real da base (31989919863)', v.validarCpf('31989919863'), '31989919863');
rejeita('CPF com dígito verificador errado', v.validarCpf('529.982.247-26'));
rejeita('CPF com todos os dígitos iguais', v.validarCpf('111.111.111-11'));
rejeita('CPF com 10 dígitos', v.validarCpf('5299822472'));
rejeita('CPF vazio quando obrigatório', v.validarCpf(''));
aceita('CPF vazio quando opcional', v.validarCpf('', { obrigatorio: false }), null);
conferir('formatarCpf', v.formatarCpf('52998224725') === '529.982.247-25');

// --------------------------------------------------------------------------
console.log('=== CNPJ ===');
aceita('CNPJ válido', v.validarCpfOuCnpj('11.222.333/0001-81'), '11222333000181');
rejeita('CNPJ com dígito errado', v.validarCpfOuCnpj('11.222.333/0001-82'));
rejeita('CNPJ com dígitos repetidos', v.validarCpfOuCnpj('11111111111111'));
aceita('CPF aceito no campo CPF-ou-CNPJ', v.validarCpfOuCnpj('52998224725'), '52998224725');
rejeita('documento com 12 dígitos', v.validarCpfOuCnpj('112223330001'));

// --------------------------------------------------------------------------
console.log('=== PIS / PASEP ===');
aceita('PIS válido', v.validarPis('120.00345.56-7'), '12000345567');
aceita('PIS válido sem máscara', v.validarPis('12345678900'), '12345678900');
aceita('PIS com dígito 0 por resto < 2', v.validarPis('00000123455'), '00000123455');
rejeita('PIS com dígito errado', v.validarPis('12000345568'));
rejeita('PIS com 10 dígitos', v.validarPis('1200034556'));
rejeita('PIS com 12 dígitos', v.validarPis('120003455670'));
rejeita('PIS com todos os dígitos iguais', v.validarPis('11111111111'));
aceita('PIS vazio é opcional', v.validarPis(''), null);
aceita('PIS "N/A" conta como vazio', v.validarPis('N/A'), null);
rejeita('PIS obrigatório e vazio', v.validarPis('', { obrigatorio: true }));
conferir('formatarPis', v.formatarPis('12000345567') === '120.00345.56-7');

// O PIS é de pessoa física: preenchido junto com CNPJ, é campo trocado.
{
  const comCnpj = v.validarCadastro(
    { proprietario_documento: '11222333000181', proprietario_pis: '12000345567' },
    { hoje: '2026-08-04' }
  );
  conferir('PIS com CNPJ é recusado', !!comCnpj.erros.proprietario_pis);

  const comCpf = v.validarCadastro(
    { proprietario_documento: '52998224725', proprietario_pis: '12000345567' },
    { hoje: '2026-08-04' }
  );
  conferir('PIS com CPF é aceito', !comCpf.erros.proprietario_pis);
}

// --------------------------------------------------------------------------
console.log('=== TAG de pedágio e rastreador (listas fechadas) ===');
aceita('TAG da lista', v.validarDaLista('SEM PARAR', v.TAGS_PEDAGIO), 'SEM PARAR');
aceita('TAG em minúsculas vira o valor da lista', v.validarDaLista('sem parar', v.TAGS_PEDAGIO), 'SEM PARAR');
aceita('TAG com espaço sobrando', v.validarDaLista('  Conect   Car ', v.TAGS_PEDAGIO), 'CONECT CAR');
rejeita('TAG fora da lista', v.validarDaLista('TAG-00123', v.TAGS_PEDAGIO));
rejeita('"SEM PARA" (grafia antiga) não passa', v.validarDaLista('SEM PARA', v.TAGS_PEDAGIO));
aceita('TAG vazia é opcional', v.validarDaLista('', v.TAGS_PEDAGIO), null);
aceita('rastreador da lista', v.validarDaLista('onixsat', v.RASTREADORES), 'ONIXSAT');
rejeita('rastreador fora da lista', v.validarDaLista('OUTRO', v.RASTREADORES));
conferir('4 rastreadores', v.RASTREADORES.length === 4);
conferir('3 TAGs', v.TAGS_PEDAGIO.length === 3);

// --------------------------------------------------------------------------
console.log('=== Grau de importancia ===');
aceita('prioridade valida', v.validarPrioridade('urgente'), 'urgente');
aceita('aceita maiusculas', v.validarPrioridade('IMEDIATO'), 'imediato');
rejeita('prioridade vazia e obrigatoria', v.validarPrioridade(''));
rejeita('valor fora da lista', v.validarPrioridade('muito_urgente'));
aceita('opcional quando pedido', v.validarPrioridade('', { obrigatorio: false }), null);
conferir('3 graus', v.PRIORIDADES.length === 3);
conferir('o primeiro e o mais urgente', v.PRIORIDADES[0].id === 'imediato');
conferir('ordem imediato < urgente', v.ordemDaPrioridade('imediato') < v.ordemDaPrioridade('urgente'));
conferir('ordem urgente < pode_aguardar', v.ordemDaPrioridade('urgente') < v.ordemDaPrioridade('pode_aguardar'));
conferir('cadastro antigo vai para o fim', v.ordemDaPrioridade(null) > v.ordemDaPrioridade('pode_aguardar'));

// --------------------------------------------------------------------------
console.log('=== Placa ===');
aceita('placa antiga', v.validarPlaca('ABC1234'), 'ABC1234');
aceita('placa antiga com hífen', v.validarPlaca('abc-1234'), 'ABC1234');
aceita('placa Mercosul', v.validarPlaca('ABC1D23'), 'ABC1D23');
aceita('placa Mercosul minúscula', v.validarPlaca('abc1d23'), 'ABC1D23');
rejeita('placa com 6 caracteres', v.validarPlaca('ABC123'));
rejeita('placa toda numérica', v.validarPlaca('1234567'));
rejeita('placa em formato inexistente (AA11111)', v.validarPlaca('AA11111'));
aceita('placa vazia é opcional', v.validarPlaca(''), null);
rejeita('placa vazia quando obrigatória', v.validarPlaca('', { obrigatorio: true }));
conferir('formatarPlaca antiga', v.formatarPlaca('ABC1234') === 'ABC-1234');
conferir('formatarPlaca Mercosul (sem hífen)', v.formatarPlaca('ABC1D23') === 'ABC1D23');

// --------------------------------------------------------------------------
console.log('=== E-mail ===');
aceita('e-mail simples', v.validarEmail('joao@jomedlog.com.br'), 'joao@jomedlog.com.br');
aceita('e-mail normalizado para minúsculas', v.validarEmail('  JOAO@Jomedlog.COM.br '), 'joao@jomedlog.com.br');
aceita('e-mail real da base', v.validarEmail('Carloseduardodemoraeshenriqueh@gmail.com'), 'carloseduardodemoraeshenriqueh@gmail.com');
rejeita('e-mail sem @', v.validarEmail('joaojomedlog.com.br'));
rejeita('e-mail sem domínio', v.validarEmail('joao@'));
rejeita('e-mail sem ponto no domínio', v.validarEmail('joao@local'));
rejeita('e-mail com espaço', v.validarEmail('jo ao@jomedlog.com.br'));

// --------------------------------------------------------------------------
console.log('=== Telefone ===');
aceita('celular com 11 dígitos', v.validarTelefone('(47) 98869-7821'), '47988697821');
aceita('fixo com 10 dígitos', v.validarTelefone('(11) 3456-7890'), '1134567890');
aceita('telefone real da base', v.validarTelefone('11 96304-0076'), '11963040076');
aceita('remove o +55 do WhatsApp', v.validarTelefone('+55 47 98869-7821'), '47988697821');
rejeita('telefone com 9 dígitos', v.validarTelefone('479886978'));
rejeita('celular de 11 dígitos sem o 9', v.validarTelefone('47888697821'));
rejeita('DDD inválido', v.validarTelefone('(01) 98869-7821'));
aceita('telefone vazio é opcional', v.validarTelefone(''), null);
conferir('formatarTelefone celular', v.formatarTelefone('47988697821') === '(47) 98869-7821');
conferir('formatarTelefone fixo', v.formatarTelefone('1134567890') === '(11) 3456-7890');

// --------------------------------------------------------------------------
console.log('=== Datas ===');
conferir('normalizarData ISO', v.normalizarData('2028-03-15') === '2028-03-15');
conferir('normalizarData BR', v.normalizarData('15/03/2028') === '2028-03-15');
conferir('normalizarData BR sem zero', v.normalizarData('5/3/2028') === '2028-03-05');
conferir('data inexistente (31/02)', v.normalizarData('31/02/2028') === null);
conferir('29/02 em ano bissexto vale', v.normalizarData('29/02/2028') === '2028-02-29');
conferir('29/02 em ano não bissexto não vale', v.normalizarData('29/02/2027') === null);
conferir('texto não é data', v.normalizarData('qualquer coisa') === null);
aceita('validade futura da CNH', v.validarData('2028-03-15', { futura: true, hoje: HOJE }), '2028-03-15');
rejeita('CNH vencida é rejeitada', v.validarData('2020-01-01', { futura: true, hoje: HOJE }));
rejeita('validade de hoje conta como vencida', v.validarData(HOJE, { futura: true, hoje: HOJE }));
conferir('diasAte no futuro', v.diasAte('2026-08-08', HOJE) === 10);
conferir('diasAte no passado', v.diasAte('2026-07-19', HOJE) === -10);

// --------------------------------------------------------------------------
console.log('=== CNH ===');
aceita('número de CNH com 11 dígitos', v.validarCnhNumero('12345678901'), '12345678901');
rejeita('número de CNH com 10 dígitos', v.validarCnhNumero('1234567890'));
aceita('categoria E', v.validarCategoriaCnh('E'), 'E');
aceita('categoria AE minúscula', v.validarCategoriaCnh('ae'), 'AE');
rejeita('categoria inexistente', v.validarCategoriaCnh('Z'));

// --------------------------------------------------------------------------
console.log('=== Vazios disfarçados (casos reais do Forms) ===');
conferir('"." é vazio', v.vazio('.') === true);
conferir('"-" é vazio', v.vazio('-') === true);
conferir('"N/A" é vazio', v.vazio('N/A') === true);
conferir('espaço é vazio', v.vazio('   ') === true);
conferir('texto real não é vazio', v.vazio('ABC1234') === false);
aceita('Rastreador ID "." tratado como ausente', v.validarTexto('.', { rotulo: 'O rastreador' }), null);

// --------------------------------------------------------------------------
console.log('=== Nome ===');
aceita('nome completo', v.validarNome('Carlos Eduardo de Moraes Henrique'));
rejeita('nome com uma só palavra', v.validarNome('Carlos'));
rejeita('nome muito curto', v.validarNome('Jo'));
rejeita('nome vazio', v.validarNome(''));
rejeita('nome só com números', v.validarNome('123 456'));

// --------------------------------------------------------------------------
console.log('=== Operações ===');
aceita('uma operação', v.validarOperacoes(['MERCADO LIVRE']));
aceita('duas operações', v.validarOperacoes(['MERCADO LIVRE', 'SHOPEE']));
conferir(
  'remove duplicadas',
  JSON.stringify(v.validarOperacoes(['SHOPEE', 'shopee']).valor) === JSON.stringify(['SHOPEE'])
);
conferir(
  'descarta vazios (o "| |" do Forms)',
  JSON.stringify(v.validarOperacoes(['MERCADO LIVRE', '', ' ', 'SHOPEE']).valor) ===
    JSON.stringify(['MERCADO LIVRE', 'SHOPEE'])
);
rejeita('nenhuma operação', v.validarOperacoes([]));
rejeita('só vazios', v.validarOperacoes(['', ' ', '|']));
rejeita('operação desconhecida', v.validarOperacoes(['MAGALU']));

// As 9 operações do formulário "CADASTRO TERCEIRO 2.0" (OPERAÇÃO 1 a 9).
conferir('são 9 operações', v.OPERACOES.length === 9, `há ${v.OPERACOES.length}`);
for (const op of ['MERCADO LIVRE', 'SHOPEE', 'AMAZON', 'SAMSUNG', 'BAYER', 'LOREAL', 'KENVUE', 'KENVUE ANGEL', 'JOMED']) {
  aceita(`operação "${op}" é aceita`, v.validarOperacoes([op]));
}
conferir(
  'KENVUE e KENVUE ANGEL são operações distintas',
  v.validarOperacoes(['KENVUE', 'KENVUE ANGEL']).valor.length === 2
);
aceita('operação em minúsculas é normalizada', v.validarOperacoes(['kenvue angel']));

// --------------------------------------------------------------------------
console.log('=== Tipos de documento (extraídos do Forms real) ===');
conferir('são 7 tipos após unificar os duplicados', v.TIPOS_DOCUMENTO.length === 7, `há ${v.TIPOS_DOCUMENTO.length}`);
conferir('ANTT existe', !!v.acharTipoDocumento('ANTT'));
conferir('"ANTT 1" (duplicado) NÃO existe mais', v.acharTipoDocumento('ANTT 1') === null);
conferir('busca por tipo ignora maiúsculas', v.acharTipoDocumento('cnh')?.id === 'CNH');
conferir('tipo inexistente devolve null', v.acharTipoDocumento('PASSAPORTE') === null);
conferir(
  'CNH é o documento mais frequente',
  v.TIPOS_DOCUMENTO[0].id === 'CNH' && v.TIPOS_DOCUMENTO[0].ocorrencias === 41
);
conferir(
  'documentos com validade são 5',
  v.TIPOS_DOCUMENTO.filter((t) => t.temValidade).length === 5
);

// --------------------------------------------------------------------------
console.log('=== Cadastro completo ===');

const cadastroBom = {
  condutor_nome: 'Carlos Eduardo de Moraes Henrique',
  condutor_cpf: '319.899.198-63',
  condutor_email: 'carlos@gmail.com',
  condutor_telefone: '47 98869-7821',
  cnh_numero: '12345678901',
  cnh_categoria: 'E',
  cnh_validade: '2028-03-15',
  proprietario_nome: 'Rodrigo Alves',
  proprietario_documento: '11.222.333/0001-81',
  proprietario_telefone: '11 96304-0076',
  placa_cavalo: 'ABC1D23',
  placa_carreta: 'XYZ4321',
  prioridade: 'urgente',
  tag: 'SEM PARAR',
  rastreador: 'SASCAR',
  rastreador_id: 'RST-998',
  obs: 'Cadastro de teste',
  operacoes: ['MERCADO LIVRE', 'SHOPEE'],
};

const bom = v.validarCadastro(cadastroBom, { hoje: HOJE });
conferir('cadastro completo válido é aceito', bom.ok, JSON.stringify(bom.erros));
conferir('CPF guardado só com dígitos', bom.dados.condutor_cpf === '31989919863');
conferir('placa normalizada', bom.dados.placa_carreta === 'XYZ4321');
conferir('operações normalizadas', JSON.stringify(bom.dados.operacoes) === JSON.stringify(['MERCADO LIVRE', 'SHOPEE']));

// O cadastro típico que o Forms aceitava hoje — deve ser REJEITADO agora
const cadastroComoOForms = {
  condutor_nome: 'Carlos Eduardo de Moraes Henrique',
  condutor_cpf: '31989919863',
  condutor_email: 'carlos@gmail.com',
  condutor_telefone: '47 8869-7821', // 10 dígitos começando com 8: fixo, tolerado
  proprietario_nome: 'Rodrigo',
  proprietario_telefone: '11 96304-0076',
  tag: '', // vazio
  placa_cavalo: '', // vazio
  placa_carreta: '', // vazio
  rastreador_id: '.', // o lixo real da base
  obs: '',
  operacoes: ['MERCADO LIVRE', 'SHOPEE', '', '', '', '', '', ''],
};
const comoForms = v.validarCadastro(cadastroComoOForms, { hoje: HOJE });
conferir('cadastro sem nenhuma placa é rejeitado', !comoForms.ok);
conferir(
  'a mensagem aponta a placa faltando',
  String(comoForms.erros.placa_cavalo || '').includes('ao menos uma placa'),
  JSON.stringify(comoForms.erros)
);

const placasIguais = v.validarCadastro(
  { ...cadastroBom, placa_carreta: cadastroBom.placa_cavalo },
  { hoje: HOJE }
);
conferir('placas iguais são rejeitadas', !placasIguais.ok && !!placasIguais.erros.placa_carreta);

const cnhVencida = v.validarCadastro({ ...cadastroBom, cnh_validade: '2020-01-01' }, { hoje: HOJE });
conferir('CNH vencida é rejeitada', !cnhVencida.ok && !!cnhVencida.erros.cnh_validade);

const semOperacao = v.validarCadastro({ ...cadastroBom, operacoes: [] }, { hoje: HOJE });
conferir('cadastro sem operação é rejeitado', !semOperacao.ok && !!semOperacao.erros.operacoes);

const varios = v.validarCadastro(
  { ...cadastroBom, condutor_cpf: '111.111.111-11', condutor_email: 'invalido', placa_cavalo: 'XX' },
  { hoje: HOJE }
);
conferir('vários erros são reportados juntos', Object.keys(varios.erros).length >= 3, JSON.stringify(varios.erros));

// --------------------------------------------------------------------------
console.log('\n----------------------------------------');
console.log(`  ✓ passaram: ${passou}`);
console.log(`  ✗ falharam: ${falhou}`);
if (falhas.length) {
  console.log('\n  Falhas:');
  for (const f of falhas) console.log(`    · ${f}`);
}
console.log('');
process.exitCode = falhou > 0 ? 1 : 0;
