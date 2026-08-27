'use strict';

const PDFDocument = require('pdfkit');

const logger = require('../utils/logger').child('ReceiptPDF');

/**
 * Generate a PDF receipt for a payment.
 *
 * @param {object} receipt - Receipt document with txHash, amount, assetCode, etc.
 * @param {object} school - School document with name, logoUrl, primaryColor, etc.
 * @returns {Stream} PDF stream readable
 */
function generateReceiptPdf(receipt, school) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
  });

  const primaryColor = school?.primaryColor || '#1a56db';
  const schoolName = school?.name || 'StellarEduPay';
  const logoUrl = school?.logoUrl;

  // Header with school branding
  if (logoUrl) {
    try {
      doc.image(logoUrl, 40, 30, { width: 60, height: 60 });
    } catch (err) {
      logger.warn('Failed to load school logo', { logoUrl, error: err.message });
    }
  }

  // School name and "RECEIPT" title
  doc
    .fontSize(14)
    .font('Helvetica-Bold')
    .fillColor(primaryColor)
    .text(schoolName, { align: 'right' });

  doc
    .fontSize(24)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text('RECEIPT', 40, 110, { align: 'center' });

  // Divider line
  doc
    .strokeColor(primaryColor)
    .lineWidth(2)
    .moveTo(40, 150)
    .lineTo(555, 150)
    .stroke();

  let yPos = 170;

  // Receipt details section
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .fillColor('#333333')
    .text('Receipt Details', 40, yPos);

  yPos += 25;

  // Transaction hash
  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#666666')
    .text('Transaction Hash:', 40, yPos);
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(receipt.txHash, 150, yPos, { width: 405 });
  yPos += 20;

  // Student information
  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#666666')
    .text('Student ID:', 40, yPos);
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(receipt.studentId, 150, yPos);
  yPos += 20;

  if (receipt.studentName) {
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#666666')
      .text('Student Name:', 40, yPos);
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#000000')
      .text(receipt.studentName, 150, yPos);
    yPos += 20;
  }

  // Amount section with highlight
  yPos += 10;
  doc
    .fillColor(primaryColor)
    .rect(40, yPos, 515, 60)
    .fill();

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#ffffff')
    .text('Amount Received:', 50, yPos + 10);
  doc
    .fontSize(20)
    .font('Helvetica-Bold')
    .fillColor('#ffffff')
    .text(`${receipt.amount} ${receipt.assetCode}`, 50, yPos + 30);

  yPos += 80;

  // Additional information
  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#666666')
    .text('Confirmation Date:', 40, yPos);
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(new Date(receipt.confirmedAt).toLocaleString(), 150, yPos);
  yPos += 20;

  if (receipt.memo) {
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#666666')
      .text('Memo:', 40, yPos);
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#000000')
      .text(receipt.memo, 150, yPos, { width: 405 });
    yPos += 20;
  }

  if (receipt.feeAmount !== null && receipt.feeAmount !== undefined) {
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#666666')
      .text('Fee Amount:', 40, yPos);
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#000000')
      .text(`${receipt.feeAmount} ${receipt.assetCode}`, 150, yPos);
    yPos += 20;
  }

  // Signature verification section
  yPos += 20;
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#999999')
    .text('Receipt Signature:', 40, yPos);
  doc
    .fontSize(8)
    .font('Courier')
    .fillColor('#666666')
    .text(receipt.signature || 'N/A', 40, yPos + 15, { width: 515, wordBreak: 'break-all' });

  // Footer
  yPos = doc.page.height - 60;
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#999999')
    .text('This is an official receipt for payment received on the Stellar blockchain.', 40, yPos, { align: 'center' });

  if (school?.supportContact) {
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#999999')
      .text(`For questions, contact: ${school.supportContact}`, 40, yPos + 15, { align: 'center' });
  }

  doc.end();
  return doc;
}

module.exports = { generateReceiptPdf };
