const crypto = require('crypto');

const COLLECTION = 'integrationSecrets';

function getSecretDocId(workspaceId) {
  return `${workspaceId}_yoco`;
}

function getCipherKey(secretValue) {
  const value = String(secretValue || '').trim();
  if (!value) throw new Error('YOCO_SECRET_ENCRYPTION_KEY is not configured.');
  return crypto.createHash('sha256').update(value).digest();
}

function encryptValue(plainText, secretValue) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getCipherKey(secretValue), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plainText || ''), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptValue(payload = {}, secretValue) {
  if (!payload.ciphertext || !payload.iv || !payload.tag) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getCipherKey(secretValue),
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function saveYocoSecrets(db, workspaceId, values = {}, secretValue) {
  const now = new Date();
  const patch = {
    workspaceId,
    provider: 'yoco',
    updatedAt: now
  };

  if (values.apiKey) {
    const encrypted = encryptValue(values.apiKey, secretValue);
    patch.apiKeyCiphertext = encrypted.ciphertext;
    patch.apiKeyIv = encrypted.iv;
    patch.apiKeyTag = encrypted.tag;
  }

  if (values.webhookSecret) {
    const encrypted = encryptValue(values.webhookSecret, secretValue);
    patch.webhookSecretCiphertext = encrypted.ciphertext;
    patch.webhookSecretIv = encrypted.iv;
    patch.webhookSecretTag = encrypted.tag;
  }

  const ref = db.collection(COLLECTION).doc(getSecretDocId(workspaceId));
  const existing = await ref.get();
  await ref.set({
    ...patch,
    createdAt: existing.exists ? existing.data().createdAt || now : now
  }, { merge: true });
}

async function getYocoSecrets(db, workspaceId, secretValue) {
  const snapshot = await db.collection(COLLECTION).doc(getSecretDocId(workspaceId)).get();
  if (!snapshot.exists) throw new Error('Yoco is not connected for this workspace.');
  const data = snapshot.data() || {};
  return {
    apiKey: decryptValue({
      ciphertext: data.apiKeyCiphertext,
      iv: data.apiKeyIv,
      tag: data.apiKeyTag
    }, secretValue),
    webhookSecret: decryptValue({
      ciphertext: data.webhookSecretCiphertext,
      iv: data.webhookSecretIv,
      tag: data.webhookSecretTag
    }, secretValue)
  };
}

async function deleteYocoSecrets(db, workspaceId) {
  await db.collection(COLLECTION).doc(getSecretDocId(workspaceId)).delete();
}

module.exports = {
  deleteYocoSecrets,
  getYocoSecrets,
  saveYocoSecrets
};
