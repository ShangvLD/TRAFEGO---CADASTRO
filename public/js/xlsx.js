/* ============================================================================
   Escritor mínimo de .xlsx, no navegador

   Um arquivo .xlsx É um ZIP com alguns XML dentro. Como o portal já tem um
   escritor de ZIP testado (public/js/zip.js, usado na exportação de
   documentos), gerar a planilha aqui não custa dependência nova nem CDN — que
   aliás seria bloqueado pela política de conteúdo em produção.

   POR QUE NÃO CSV: o CSV abre no Excel, mas quebra em detalhes que aparecem
   justo com dados brasileiros — vírgula decimal, acento, e placa/CPF que o
   Excel transforma em número. No xlsx cada célula declara o tipo e nada é
   reinterpretado.

   ESCOPO: uma aba, texto e número, com a primeira linha em negrito e
   congelada. É o que um relatório tabular precisa; fórmula, cor e gráfico
   ficam de fora de propósito.

   Depende de /js/zip.js.
   ========================================================================== */

(function () {
    'use strict';

    /** Escapa o que não pode aparecer cru dentro de um XML. */
    function esc(txt) {
        return String(txt == null ? '' : txt)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            // Controles (exceto tab, LF e CR) são inválidos em XML 1.0 e
            // corrompem o arquivo inteiro — o Excel recusa a planilha sem
            // dizer por quê. Vêm de observação colada de outro sistema.
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    }

    /** A1, B1, ... Z1, AA1 — a referência que o Excel usa para cada célula. */
    function referencia(coluna, linha) {
        let nome = '';
        let n = coluna;
        while (n >= 0) {
            nome = String.fromCharCode(65 + (n % 26)) + nome;
            n = Math.floor(n / 26) - 1;
        }
        return nome + (linha + 1);
    }

    function ehNumero(v) {
        return typeof v === 'number' && Number.isFinite(v);
    }

    function celula(valor, col, lin, cabecalho) {
        const ref = referencia(col, lin);
        const estilo = cabecalho ? ' s="1"' : '';

        if (ehNumero(valor)) {
            return `<c r="${ref}"${estilo}><v>${valor}</v></c>`;
        }
        const txt = valor == null ? '' : String(valor);
        if (!txt) return `<c r="${ref}"${estilo}/>`;

        // inlineStr em vez de sharedStrings: mais bytes, mas dispensa a tabela
        // de strings e o índice que precisaria ser mantido em sincronia.
        // xml:space="preserve" mantém espaços das pontas, que somem sem ele.
        return `<c r="${ref}"${estilo} t="inlineStr"><is><t xml:space="preserve">${esc(txt)}</t></is></c>`;
    }

    /**
     * Monta o .xlsx.
     *
     * @param colunas  [{ titulo, largura }]
     * @param linhas   array de arrays, na ordem das colunas
     * @param aba      nome da aba
     * @returns Blob pronto para download
     */
    function gerar(colunas, linhas, aba) {
        const cols = colunas.map((c) => (typeof c === 'string' ? { titulo: c } : c));

        const largura = cols
            .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura || 18}" customWidth="1"/>`)
            .join('');

        const cabecalho =
            '<row r="1">' + cols.map((c, i) => celula(c.titulo, i, 0, true)).join('') + '</row>';

        const corpo = linhas
            .map((linha, l) =>
                `<row r="${l + 2}">` +
                cols.map((_, c) => celula(linha[c], c, l + 1, false)).join('') +
                '</row>'
            )
            .join('');

        const sheet =
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            // Congela a primeira linha: rolar uma tabela larga sem cabeçalho
            // fixo obriga a subir toda hora para saber que coluna é qual.
            '<sheetViews><sheetView workbookViewId="0">' +
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
            '</sheetView></sheetViews>' +
            `<cols>${largura}</cols>` +
            `<sheetData>${cabecalho}${corpo}</sheetData>` +
            // Autofiltro no cabeçalho: quem abre a planilha já filtra sem
            // precisar selecionar o intervalo na mão.
            `<autoFilter ref="A1:${referencia(cols.length - 1, linhas.length)}"/>` +
            '</worksheet>';

        const nomeAba = esc(String(aba || 'Dados').slice(0, 31)).replace(/[\\\/\?\*\[\]:]/g, '');

        const zip = new window.ZipSimples();
        const texto = (s) => new TextEncoder().encode(s);

        zip.adicionar('[Content_Types].xml', texto(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            '</Types>'
        ));

        zip.adicionar('_rels/.rels', texto(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>'
        ));

        zip.adicionar('xl/workbook.xml', texto(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            `<sheets><sheet name="${nomeAba}" sheetId="1" r:id="rId1"/></sheets>` +
            '</workbook>'
        ));

        zip.adicionar('xl/_rels/workbook.xml.rels', texto(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
            '</Relationships>'
        ));

        // Dois estilos só: o 0 é o normal, o 1 é o cabeçalho em negrito. O
        // Excel exige o arquivo de estilos mesmo quando não se usa nenhum.
        zip.adicionar('xl/styles.xml', texto(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
            '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
            '<borders count="1"><border/></borders>' +
            '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
            '<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>' +
            '</styleSheet>'
        ));

        zip.adicionar('xl/worksheets/sheet1.xml', texto(sheet));

        return new Blob([zip.gerar()], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
    }

    window.gerarXlsx = gerar;
})();
