'use strict';

const { getReceiptByTxHash } = require('../services/receiptService');
const School = require('../models/schoolModel');

// GET /api/receipts/:txHash?format=pdf
async function getReceipt(req, res, next) {
  try {
    const receipt = await getReceiptByTxHash(req.params.txHash, req.schoolId);
    if (!receipt) {
      const err = new Error('Receipt not found for this transaction');
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const format = req.query.format?.toLowerCase();

    // JSON is the default format
    if (!format || format === 'json') {
      return res.json(receipt);
    }

    // PDF format
    if (format === 'pdf') {
      try {
        const { generateReceiptPdf } = require('../services/receiptPdfService');

        // Fetch school branding information
        const school = await School.findOne({ schoolId: req.schoolId }).lean();

        // Generate PDF stream
        const pdfStream = generateReceiptPdf(receipt, school);

        // Set response headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename=receipt-${receipt.txHash}.pdf`
        );

        // Stream the PDF to response
        pdfStream.pipe(res);

        // Handle errors during streaming
        pdfStream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).json({ code: 'PDF_GENERATION_ERROR', error: 'Failed to generate PDF' });
          } else {
            res.end();
          }
        });
      } catch (err) {
        // If pdfkit is not installed or other PDF errors occur
        const error = new Error(
          'PDF generation is not available. Please ensure pdfkit is installed.'
        );
        error.code = 'PDF_UNAVAILABLE';
        return next(error);
      }
    } else {
      const err = new Error(`Unsupported format: ${format}. Use 'json' or 'pdf'.`);
      err.code = 'INVALID_FORMAT';
      return next(err);
    }
  } catch (err) {
    next(err);
  }
}

module.exports = { getReceipt };

