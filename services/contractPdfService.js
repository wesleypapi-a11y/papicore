/*
 * contractPdfService.js
 *
 * Geração do PDF de um contrato já finalizado, usando PDFKit (biblioteca
 * puro Node, sem Chromium/Puppeteer) — mais estável e leve para rodar no
 * plano gratuito/básico do Render do que um navegador headless.
 *
 * IMPORTANTE: o PDF é renderizado a partir do *snapshot* congelado do
 * contrato (contract.content + provider_snapshot_json), nunca a partir dos
 * dados "ao vivo" da contratada/cliente — assim o PDF de um contrato antigo
 * nunca muda mesmo que os dados cadastrais mudem depois.
 */

const fs = require('fs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const { storedPlatformFilePath } = require('../utils/assetStorage');
const contractStorage = require('../utils/contractStorage');

const CONTRACT_TYPE_LABELS = {
  SUBSCRIPTION: 'Contrato de Licença e Prestação de Serviços',
  RENEWAL: 'Termo de Renovação Contratual',
  ADDENDUM: 'Termo Aditivo Contratual',
  CANCELLATION: 'Termo de Distrato',
  CUSTOM: 'Contrato'
};

const PAGE_MARGIN = { top: 90, bottom: 70, left: 56, right: 56 };

function contractTypeLabel(type) {
  return CONTRACT_TYPE_LABELS[type] || CONTRACT_TYPE_LABELS.CUSTOM;
}

function drawHeader(doc, contract, provider) {
  const logoFile = storedPlatformFilePath('contract_logo');
  let textX = PAGE_MARGIN.left;
  if (logoFile) {
    try {
      doc.image(logoFile, PAGE_MARGIN.left, 30, { fit: [90, 40] });
      textX = PAGE_MARGIN.left + 100;
    } catch { /* imagem corrompida/ilegível: segue sem logo */ }
  }
  doc.fontSize(9).fillColor('#555').text(provider.trade_name || provider.legal_name || 'PapiCore', textX, 34, { align: 'left' });
  doc.fontSize(8).fillColor('#888').text(provider.document || '', textX, 48);
  doc.fillColor('#000');

  doc.fontSize(15).font('Helvetica-Bold').text(contractTypeLabel(contract.contract_type), PAGE_MARGIN.left, 90, {
    align: 'center',
    width: doc.page.width - PAGE_MARGIN.left - PAGE_MARGIN.right
  });
  doc.fontSize(10).font('Helvetica').text(`Contrato nº ${contract.contract_number}`, { align: 'center' });
  doc.moveDown(1.2);
}

function drawBody(doc, contract) {
  const paragraphs = String(contract.content || '').split(/\n{2,}/);
  doc.font('Helvetica').fontSize(10.5).fillColor('#000');
  paragraphs.forEach((paragraph) => {
    const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    doc.text(lines.join('\n'), { align: 'justify', lineGap: 2 });
    doc.moveDown(0.7);
  });
}

function drawSignatures(doc, contract, provider) {
  if (doc.y > doc.page.height - PAGE_MARGIN.bottom - 160) doc.addPage();
  doc.moveDown(2);
  const today = new Date();
  doc.fontSize(10).text(
    `${provider.city || 'Local'}, ${today.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}.`,
    { align: 'center' }
  );
  doc.moveDown(3);

  const colWidth = (doc.page.width - PAGE_MARGIN.left - PAGE_MARGIN.right - 30) / 2;
  const leftX = PAGE_MARGIN.left;
  const rightX = PAGE_MARGIN.left + colWidth + 30;
  const lineY = doc.y;

  doc.moveTo(leftX, lineY).lineTo(leftX + colWidth, lineY).stroke();
  doc.moveTo(rightX, lineY).lineTo(rightX + colWidth, lineY).stroke();

  doc.fontSize(9);
  doc.text('CONTRATADA', leftX, lineY + 6, { width: colWidth, align: 'center' });
  doc.text(provider.legal_name || '', leftX, lineY + 20, { width: colWidth, align: 'center' });
  doc.text(provider.representative_name || '', leftX, lineY + 33, { width: colWidth, align: 'center' });
  if (provider.representative_document) {
    doc.text(provider.representative_document, leftX, lineY + 46, { width: colWidth, align: 'center' });
  }

  doc.text('CONTRATANTE', rightX, lineY + 6, { width: colWidth, align: 'center' });
  doc.text(contract.client_name || '', rightX, lineY + 20, { width: colWidth, align: 'center' });
  if (contract.client_document) {
    doc.text(contract.client_document, rightX, lineY + 33, { width: colWidth, align: 'center' });
  }
}

function drawFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.height - PAGE_MARGIN.bottom + 20;
    doc.fontSize(8).fillColor('#888').text(
      `Página ${i + 1 - range.start} de ${range.count}`,
      PAGE_MARGIN.left,
      bottom,
      { width: doc.page.width - PAGE_MARGIN.left - PAGE_MARGIN.right, align: 'center' }
    );
  }
}

/* Renderiza o PDF em memória (Buffer) a partir de um contrato já persistido. */
function renderContractPdf(contract) {
  const provider = JSON.parse(contract.provider_snapshot_json || '{}');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: `Contrato ${contract.contract_number}`,
        Author: provider.legal_name || 'PapiCore'
      }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, contract, provider);
    drawBody(doc, contract);
    drawSignatures(doc, contract, provider);
    drawFooter(doc);

    doc.end();
  });
}

/* Gera o PDF, grava em DATA_DIR/contracts/<ano>/tenant_XXXX/<numero>.pdf e
   devolve { relativePath, sha256, sizeBytes } para persistir no registro do
   contrato. Nunca grava em public/. */
async function generateAndStoreContractPdf(contract) {
  const buffer = await renderContractPdf(contract);
  const absolutePath = contractStorage.contractPdfPath(contract.tenant_id, contract.year, contract.contract_number);
  fs.writeFileSync(absolutePath, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    relativePath: contractStorage.relativeContractPath(contract.tenant_id, contract.year, contract.contract_number),
    sha256,
    sizeBytes: buffer.length
  };
}

module.exports = {
  renderContractPdf,
  generateAndStoreContractPdf
};
