import crypto from "crypto";
import fs from "fs";

export function encryptText(text, password) {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(password).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

export function decryptText(encrypted, password) {
  const key = crypto.createHash("sha256").update(password).digest();
  const iv = Buffer.from(encrypted.iv, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function encryptFile(filePath, password) {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(password).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

  const input = fs.readFileSync(filePath);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const encryptedPath = filePath + ".enc";

  fs.writeFileSync(encryptedPath, encrypted);

  return {
    path: encryptedPath,
    iv: iv.toString("hex"),
  };
}

export function decryptFile(encryptedPath, password, ivHex, outputPath) {
  const key = crypto.createHash("sha256").update(password).digest();
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  const input = fs.readFileSync(encryptedPath);
  const decrypted = Buffer.concat([decipher.update(input), decipher.final()]);
  fs.writeFileSync(outputPath, decrypted);
}
