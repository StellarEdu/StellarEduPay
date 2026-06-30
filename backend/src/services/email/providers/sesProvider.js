'use strict';

/**
 * AWS SES email provider.
 *
 * The AWS SDK is an optional peer dependency — it is required lazily so the
 * application runs without it unless EMAIL_PROVIDER=ses is actually selected.
 * Bounces and complaints are delivered asynchronously by SES via SNS and handled
 * by the email webhook controller, which feeds the suppression list.
 */

const config = require('../../../config');

let _client = null;
let _SendEmailCommand = null;

function getClient() {
  if (_client) return _client;
  let SESClient;
  try {
    ({ SESClient, SendEmailCommand: _SendEmailCommand } = require('@aws-sdk/client-ses'));
  } catch (_) {
    throw new Error(
      'EMAIL_PROVIDER=ses requires the "@aws-sdk/client-ses" package to be installed'
    );
  }
  _client = new SESClient({ region: config.AWS_REGION || process.env.AWS_REGION });
  return _client;
}

module.exports = {
  name: 'ses',

  async send(message) {
    const client = getClient();
    const command = new _SendEmailCommand({
      Source: message.from || config.SMTP_FROM,
      Destination: { ToAddresses: [message.to] },
      Message: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: message.text || '', Charset: 'UTF-8' },
          ...(message.html && { Html: { Data: message.html, Charset: 'UTF-8' } }),
        },
      },
    });
    const res = await client.send(command);
    return { messageId: res.MessageId };
  },

  async verify() {
    try {
      getClient();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  _reset() {
    _client = null;
    _SendEmailCommand = null;
  },
};
