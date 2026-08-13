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

const COLUNAS = [
  'rotulo', 'tipo', 'secao', 'icone', 'obrigatorio',
  'ordem', 'largura', 'dica', 'placeholder', 'opcoes', 'max_tamanho', 'sistema',
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
      });
    }
  }
  return linhas;
}

function mostrar(valor) {
  if (valor === null || valor === undefined) return '—';
  return String(valor);
}

async function copiar(slug, { aplicar = false } = {}) {
  if (!acharModulo(slug)) {
    console.log(`Módulo "${slug}" não existe. Use terceiro, agregado ou candidato.`);
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
    const diferentes = COLUNAS.filter((col) => {
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
  console.log(`  No código: ${esperado.length} campos | no banco: ${atuais.length}\n`);

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
  await db.transacao(async (q) => {
    for (const m of mudancas) {
      await q(
        `UPDATE cfg_campos SET ${COLUNAS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...COLUNAS.map((c) => m.esperado[c]), m.atual.id]
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

module.exports = { copiar, esperadoDe };

// Execução direta pela linha de comando.
if (require.main === module) {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const aplicar = args.includes('--aplicar');

  if (!slug) {
    console.log('\n  Uso: node src/copiar-campos.js <modulo> [--aplicar]\n');
    process.exit(1);
  }

  copiar(slug, { aplicar })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
