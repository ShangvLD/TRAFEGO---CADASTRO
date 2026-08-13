/* ============================================================================
   Recopia os campos de um módulo do CÓDIGO para a configuração no banco

   Por que existe um script separado, em vez de a semeadura fazer isso:
   semear() grava com ON CONFLICT DO NOTHING de propósito. O código é a
   SEMENTE; depois da primeira inicialização quem manda é a tela de
   configuração. Se a semeadura regravasse, todo deploy desfaria em silêncio o
   que o admin tivesse ajustado — o pior tipo de bug, porque some sem erro.

   Então a recópia é um ato deliberado, rodado à mão, e que por padrão só
   MOSTRA o que mudaria:

     node src/copiar-campos.js terceiro              # mostra o diff
     node src/copiar-campos.js terceiro --aplicar    # grava

   O que ele NÃO faz: apagar pergunta que existe no banco e não existe no
   código. Ela é listada e deixada em paz — uma pergunta criada pela tela é
   dado do usuário, e apagar sem pedir jogaria fora as respostas dela.
   ========================================================================== */

const db = require('./db');
const campos = require('./campos');
const { acharModulo } = require('./modulos');
const { TIPOS_DOCUMENTO } = require('./validacao');
const { normalizarEscopo } = require('./pesquisas');

const COLUNAS = [
  'rotulo', 'tipo', 'secao', 'icone', 'obrigatorio',
  'ordem', 'largura', 'dica', 'placeholder', 'opcoes', 'max_tamanho', 'sistema', 'escopo',
];

/** A especificação do código, achatada em uma linha por campo. */
function esperadoDe(slug) {
  const linhas = [];
  let ordem = 0;

  for (const secao of campos.secoesDe(slug)) {
    for (const c of secao.campos) {
      ordem += 1;
      linhas.push({
        campo_id: c.id,
        rotulo: c.rotulo,
        tipo: c.tipo,
        secao: secao.secao,
        icone: secao.icone || null,
        obrigatorio: c.obrigatorio ? 1 : 0,
        ordem,
        largura: c.largura || null,
        dica: c.dica || null,
        placeholder: c.placeholder || null,
        opcoes: c.opcoes ? JSON.stringify(c.opcoes) : null,
        max_tamanho: c.max || null,
        sistema: c.sistema ? 1 : 0,
        escopo: normalizarEscopo(c.escopo),
      });
    }
  }
  return linhas;
}

function mostrar(valor) {
  if (valor === null || valor === undefined) return '—';
  return String(valor);
}

/**
 * @param opcoes.aplicar  false (padrão) só mostra o diff
 * @param opcoes.colunas  restringe quais colunas são comparadas e regravadas.
 *
 * O "colunas" existe por uma razão prática e importante: depois que o admin
 * começa a editar pela tela, uma recópia COMPLETA desfaz o trabalho dele —
 * devolve os rótulos, a obrigatoriedade e a ordem para o que está no código.
 * Quando o motivo da recópia é uma coluna NOVA (que ninguém teve como editar
 * ainda), copiar só ela é o certo:
 *
 *   node src/copiar-campos.js terceiro --somente escopo --aplicar
 */
async function copiar(slug, { aplicar = false, colunas = null } = {}) {
  if (!acharModulo(slug)) {
    console.log(`Módulo "${slug}" não existe. Use terceiro, agregado ou candidato.`);
    return { ok: false };
  }

  const usadas = Array.isArray(colunas) && colunas.length
    ? COLUNAS.filter((c) => colunas.includes(c))
    : COLUNAS;

  if (!usadas.length) {
    console.log(`Nenhuma coluna conhecida em "${colunas.join(', ')}". Conhecidas: ${COLUNAS.join(', ')}.`);
    return { ok: false };
  }

  await db.ensureReady();

  const esperado = esperadoDe(slug);
  if (!esperado.length) {
    console.log(`O módulo "${slug}" não tem campos especificados em src/campos.js.`);
    return { ok: false };
  }

  const atuais = await db
    .prepare(`SELECT id, campo_id, ${COLUNAS.join(', ')} FROM cfg_campos WHERE modulo = ? ORDER BY ordem, id`)
    .all(slug);
  const porCampoId = new Map(atuais.map((l) => [l.campo_id, l]));

  const novos = [];
  const mudancas = [];

  for (const e of esperado) {
    const atual = porCampoId.get(e.campo_id);
    if (!atual) {
      novos.push(e);
      continue;
    }
    const diferentes = usadas.filter((col) => {
      const de = atual[col] === undefined ? null : atual[col];
      const para = e[col];
      // O banco devolve número onde o código tem número; comparar como texto
      // evita 1 !== "1" acusar mudança que não existe.
      return String(de === null ? '' : de) !== String(para === null ? '' : para);
    });
    if (diferentes.length) mudancas.push({ atual, esperado: e, diferentes });
  }

  const sobrando = atuais.filter((l) => !esperado.some((e) => e.campo_id === l.campo_id));

  // ---- Relatório ----
  console.log(`\n  Módulo: ${slug}`);
  console.log(`  No código: ${esperado.length} campos | no banco: ${atuais.length}`);
  console.log(`  Colunas consideradas: ${usadas.join(', ')}\n`);

  for (const n of novos) {
    console.log(`  + ${n.campo_id}  (não existe no banco — será criado)`);
  }

  for (const m of mudancas) {
    console.log(`  ~ ${m.atual.campo_id}`);
    for (const col of m.diferentes) {
      console.log(`      ${col.padEnd(12)} ${mostrar(m.atual[col])}  ->  ${mostrar(m.esperado[col])}`);
    }
  }

  for (const s of sobrando) {
    console.log(`  ! ${s.campo_id}  existe só no banco (criado pela tela?) — NÃO será tocado`);
  }

  if (!novos.length && !mudancas.length) {
    console.log('  Nada a fazer: a configuração já é igual ao código.\n');
    return { ok: true, mudancas: 0, novos: 0 };
  }

  if (!aplicar) {
    console.log(`\n  ${mudancas.length} campo(s) a atualizar, ${novos.length} a criar.`);
    console.log('  Nada foi gravado. Rode de novo com --aplicar para gravar.\n');
    return { ok: true, mudancas: mudancas.length, novos: novos.length, aplicado: false };
  }

  // ---- Gravação, tudo numa transação ----
  //
  // Grava só as colunas CONSIDERADAS, não todas: com --somente escopo, tocar
  // no rótulo e na obrigatoriedade desfaria o que o admin ajustou pela tela.
  await db.transacao(async (q) => {
    for (const m of mudancas) {
      await q(
        `UPDATE cfg_campos SET ${usadas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...usadas.map((c) => m.esperado[c]), m.atual.id]
      );
    }
    for (const n of novos) {
      await q(
        `INSERT INTO cfg_campos (modulo, campo_id, ativo, ${COLUNAS.join(', ')})
         VALUES (?, ?, 1, ${COLUNAS.map(() => '?').join(', ')})`,
        [slug, n.campo_id, ...COLUNAS.map((c) => n[c])]
      );
    }
  });

  console.log(`\n  Gravado: ${mudancas.length} atualizado(s), ${novos.length} criado(s).`);
  console.log('  O "ativo" de cada campo foi preservado — a recópia não religa o que estava desligado.\n');
  return { ok: true, mudancas: mudancas.length, novos: novos.length, aplicado: true };
}

/**
 * Copia SÓ o escopo dos anexos do terceiro (a quem cada documento pertence).
 *
 * Separado de copiar(): o resto da configuração de anexo — rótulo, validade,
 * obrigatoriedade, quais operações exigem — é do admin há tempo, e regravar
 * tudo a partir do código desfaria isso. O escopo é a única coluna que nasceu
 * agora e que ninguém teve chance de editar ainda.
 */
async function copiarEscopoDosAnexos({ aplicar = false } = {}) {
  await db.ensureReady();

  const atuais = await db
    .prepare("SELECT id, codigo, rotulo, escopo FROM cfg_documentos WHERE modulo = 'terceiro'")
    .all();

  const mudancas = [];
  for (const doc of atuais) {
    const espec = TIPOS_DOCUMENTO.find((t) => t.id === String(doc.codigo).toUpperCase());
    if (!espec) continue; // documento criado pela tela: o admin define o escopo lá
    const alvo = normalizarEscopo(espec.escopo);
    if (doc.escopo !== alvo) mudancas.push({ doc, alvo });
  }

  console.log(`\n  Anexos do terceiro: ${atuais.length} no banco\n`);
  for (const m of mudancas) {
    console.log(`  ~ ${m.doc.codigo.padEnd(24)} escopo  ${m.doc.escopo}  ->  ${m.alvo}`);
  }
  const semEspec = atuais.filter((d) => !TIPOS_DOCUMENTO.some((t) => t.id === String(d.codigo).toUpperCase()));
  for (const d of semEspec) {
    console.log(`  ! ${d.codigo.padEnd(24)} criado pela tela — escopo definido em /admin/formulario`);
  }

  if (!mudancas.length) {
    console.log('  Nada a fazer: o escopo dos anexos já está igual ao código.\n');
    return { ok: true, mudancas: 0 };
  }
  if (!aplicar) {
    console.log(`\n  ${mudancas.length} anexo(s) a atualizar. Nada foi gravado — use --aplicar.\n`);
    return { ok: true, mudancas: mudancas.length, aplicado: false };
  }

  await db.transacao(async (q) => {
    for (const m of mudancas) {
      await q('UPDATE cfg_documentos SET escopo = ? WHERE id = ?', [m.alvo, m.doc.id]);
    }
  });
  console.log(`\n  Gravado: ${mudancas.length} anexo(s) atualizado(s).\n`);
  return { ok: true, mudancas: mudancas.length, aplicado: true };
}

module.exports = { copiar, copiarEscopoDosAnexos, esperadoDe };

// Execução direta pela linha de comando.
if (require.main === module) {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');

  // "--somente escopo,rotulo" consome o argumento seguinte, então ele não pode
  // ser confundido com o nome do módulo.
  const iSomente = args.indexOf('--somente');
  const colunas = iSomente >= 0 && args[iSomente + 1]
    ? args[iSomente + 1].split(',').map((c) => c.trim()).filter(Boolean)
    : null;
  const slug = args.find((a, i) => !a.startsWith('--') && i !== iSomente + 1);

  if (!slug) {
    console.log('\n  Uso: node src/copiar-campos.js <modulo> [--somente col1,col2] [--aplicar]');
    console.log(`  Colunas: ${COLUNAS.join(', ')}\n`);
    process.exit(1);
  }

  copiar(slug, { aplicar, colunas })
    .then(async (r) => {
      // O escopo dos anexos so existe no terceiro.
      if (r.ok && slug === 'terceiro') await copiarEscopoDosAnexos({ aplicar });
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
