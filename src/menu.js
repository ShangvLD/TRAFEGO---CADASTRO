/* ============================================================================
   Menu de navegação, montado a partir das permissões

   Antes o menu era HTML fixo, repetido em cada view, com atributos
   `data-admin-only` para esconder itens. Com 3 módulos e 9 papéis isso não
   escala: cada módulo novo exigiria editar todas as páginas.

   Agora o servidor devolve o menu em /api/eu e o public/js/app.js o desenha.
   Acrescentar um módulo em src/modulos.js faz o item aparecer em TODAS as
   páginas, para os papéis certos, sem tocar em nenhuma view.
   ========================================================================== */

const { MODULOS, rotaFormulario, rotaPainel, dominioPermitido } = require('./modulos');
const papeis = require('./papeis');

/**
 * Itens de menu visíveis para um usuário.
 * @param usuario { papel, email }
 * @returns [{ href, rotulo, icone }]
 */
function menuPara(usuario) {
  if (!usuario) return [];

  const { papel, email } = usuario;
  const admin = papeis.ehAdmin(papel);
  const itens = [];

  // ---- "Solicitar": a página com o Microsoft Forms embutido ---------------
  // Pertence ao fluxo de terceiro, então só aparece para quem preenche esse
  // módulo. Agregado e candidato não têm nada a ver com ela.
  if (papeis.podeFormulario(papel, 'terceiro')) {
    itens.push({ href: '/solicitante', rotulo: 'Solicitar', icone: 'note_add' });
  }

  // ---- Um item por formulário liberado ------------------------------------
  for (const m of MODULOS) {
    if (!papeis.podeFormulario(papel, m.slug)) continue;
    // Módulo em validação: só admin vê o item (o middleware também bloqueia,
    // mas mostrar um link que dá 403 é péssima experiência).
    if (m.somenteAdmin && !admin) continue;
    // Restrição de domínio: não anuncia formulário que a pessoa não pode abrir.
    if (!dominioPermitido(m, email)) continue;

    itens.push({ href: rotaFormulario(m.slug), rotulo: m.rotulo, icone: m.icone });
  }

  // ---- Acompanhamento das próprias solicitações ---------------------------
  // Aparece para quem preenche algum formulário — inclusive agregado e
  // candidato, que precisam acompanhar o que enviaram.
  if (papeis.formulariosDoPapel(papel).length) {
    itens.push({ href: '/minhas-solicitacoes', rotulo: 'Minhas solicitações', icone: 'fact_check' });
  }

  // ---- Painéis de aprovação ----------------------------------------------
  const paineis = papeis.paineisDoPapel(papel);
  for (const slug of paineis) {
    const m = MODULOS.find((x) => x.slug === slug);
    if (!m) continue;
    itens.push({
      href: rotaPainel(slug),
      // Com um painel só, "Painel de aprovação" é mais claro; com vários,
      // precisa dizer de qual módulo é.
      rotulo: paineis.length === 1 ? 'Painel de aprovação' : `Painel ${m.rotuloCurto}`,
      // Ícone próprio do painel (definido no módulo): distingue "preencher o
      // formulário de X" de "acompanhar o painel de X", que ficariam com o
      // mesmo ícone se ambos usassem `icone`.
      icone: m.iconePainel || 'rule',
    });
  }

  return itens;
}

/** Itens do menu da conta (canto superior direito). */
function menuDaConta(usuario) {
  const itens = [];
  if (usuario && papeis.ehAdmin(usuario.papel)) {
    itens.push({ href: '/admin/usuarios', rotulo: 'Usuários', icone: 'group' });
    itens.push({ href: '/admin/formulario', rotulo: 'Configurar formulário', icone: 'tune' });
  }

  // Relatórios fica no menu da CONTA, e não na navegação principal, porque é
  // uma leitura gerencial — consultada de vez em quando, não a cada cadastro.
  // Misturá-la com o trabalho do dia a dia foi o que deixou a tela de
  // acompanhamento poluída.
  //
  // Visível a quem enxerga algum painel: quem só preenche formulário vê apenas
  // as próprias solicitações, e um indicador sobre elas não diria nada.
  if (usuario && papeis.paineisDoPapel(usuario.papel).length) {
    itens.push({ href: '/relatorios', rotulo: 'Relatórios', icone: 'monitoring' });
  }
  return itens;
}

module.exports = { menuPara, menuDaConta };
