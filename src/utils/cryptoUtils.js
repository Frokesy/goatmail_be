import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey() {
    if (!process.env.ENCRYPTION_KEY) {
        throw new Error("❌ ENCRYPTION_KEY not set in .env");
    }
    return Buffer.from(process.env.ENCRYPTION_KEY, "hex");
}
export function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

    const encrypted = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString("hex"),
        content: encrypted.toString("hex"),
        tag: tag.toString("hex"),
    };
}

export function decrypt(encryptedObj) {
    const { iv, content, tag } = encryptedObj;

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        getKey(),
        Buffer.from(iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(tag, "hex"));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(content, "hex")),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
}